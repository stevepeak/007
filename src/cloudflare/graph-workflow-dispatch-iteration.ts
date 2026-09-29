import { NonRetryableError } from 'cloudflare:workflows'

import type { IterationNode } from '../engine/graph'
import { iterationItemTitle } from '../engine/item-title'
import { modelBudgetFor } from '../engine/model-budget'
import {
  executeSubgraph,
  IterationTooManyItemsError,
  resolveIterationList,
  runIteration,
} from '../engine/nodes/iteration'
import { withoutUserProgress, type StreamSink } from '../engine/stream-sink'
import { createWfDb } from '../storage/client'
import { createRun } from '../storage/data'

import { calleeEventType, iterationItemParams } from './callee-protocol'
import type { CalleeDoneWire } from './callee-protocol'
import type { GraphWorkflowEnv } from './graph-workflow'
import type {
  RunCtx,
  RunStepResult,
} from './graph-workflow-dispatch-run-ctx'
import { spillAtBoundary } from './graph-workflow-dispatch-spill'
import { stepDo } from './graph-workflow-dispatch-step'
import {
  DEFAULT_STEP_OPTS,
  resolveStepTimeoutMs,
  stepOptsFor,
} from './graph-workflow-dispatch-step-opts'
import { createTelemeteredRecorder } from './graph-workflow-telemetry'
import { releaseFromEnv } from './release'
import { runContextFor } from './run-context'

// Run one iteration node. Iteration orchestrates its own per-item durable steps,
// so it is NOT wrapped in a single `run:` step — `step.do` and `waitForEvent`
// can't nest inside one.
//
// What an item IS depends on `itemExecution`:
//   • inline  — one top-level `iter:<node>:<i>` step running the subgraph in
//     THIS instance (`runItemInline`),
//   • durable — a child instance of its own, spawned and awaited over
//     `spawn:<node>:<i>` + `await:<node>:<i>` (`runItemAsChildInstance`).
//
// Every one of those names is built from the ITEM INDEX, never from completion
// order or a worker slot. That is what makes the pool below safe to replay: it
// hands indices to workers in completion order, which a replay does not
// reproduce, but the journal is addressed by name — and a name the journal
// doesn't have is EXECUTED, which for the durable path would mean an orphan
// child instance.
//
// The outer `runIteration` only awaits the items under its concurrency pool and
// collects the ordered results. The whole iteration is still recorded as ONE
// run-step by the caller (output = the collection).
export async function dispatchIteration<TDeps, E extends GraphWorkflowEnv>(
  ctx: RunCtx<TDeps, E>,
  node: IterationNode,
  /** The node's own feed writer, built by the caller (there is no `run:` step
   * here to host one). Carries the loop's note and per-item ticks. */
  nodeSink: StreamSink,
): Promise<RunStepResult> {
  const { p, scheduler } = ctx
  // The two item executions differ ONLY in what one item does — the list, the
  // fence, the pool, the ordering and the counters are shared, so they are
  // written once here and the mode picks a `runItem`. Anything that has to hold
  // for both (results in item order, the fence firing before any work starts)
  // then cannot drift between them.
  const runItem =
    node.config.itemExecution === 'durable'
      ? (item: unknown, index: number) => {
          return runItemAsChildInstance(ctx, node, item, index)
        }
      : (item: unknown, index: number) => runItemInline(ctx, node, item, index)

  // The fan-out fence throws before a single step is taken or a single instance
  // created, and the list it rejected is the same list every replay resolves —
  // retrying only spends the budget the fence just refused.
  const iter = await runIteration({
    node,
    // List is a ref into an upstream output, resolved against the
    // scheduler's global outputs — not the forwarded input.
    list: resolveIterationList(node, scheduler.getOutputs()),
    sink: nodeSink,
    promptVariables: p.runContext.promptVariables,
    runItem,
  }).catch((err: unknown) => {
    if (err instanceof IterationTooManyItemsError) {
      throw new NonRetryableError(err.message)
    }
    throw err
  })
  // The main step multiplier: an iteration spends steps per ITEM instead of a
  // single `run:`, so a wide list is what makes a graph expensive.
  // `iter.meta.total` is journaled, so this re-accumulates identically on replay.
  ctx.counters.iterationItems += iter.meta.total
  return {
    schedulerOutput: iter.results,
    recordedOutput: iter.results,
    meta: iter.meta,
  }
}

/**
 * One item, run inside the parent instance as a single all-or-nothing step.
 *
 * The iteration node creates no `run:` step of its own — these per-item steps
 * are the only ones it has, so its `execution` policy governs ONE ITEM.
 * `stepOptsFor` and `resolveStepTimeoutMs` read that same policy, which is what
 * keeps the item's wall-clock timeout and the in-process budget derived from it
 * in agreement.
 */
async function runItemInline<TDeps, E extends GraphWorkflowEnv>(
  ctx: RunCtx<TDeps, E>,
  node: IterationNode,
  item: unknown,
  index: number,
): Promise<unknown> {
  const { step, env, config, p, manifest } = ctx
  // The loop speaks for its whole body. Its subgraph gets the run-level sink
  // with USER-facing lines stripped: a step inside a loop has nowhere to be
  // shown — the feed is one flat list — so it stays quiet until there is a
  // per-item surface for it. Its dev trace is unaffected.
  const itemSink = withoutUserProgress(ctx.sink)
  return await stepDo(
    step,
    `iter:${node.id}:${index}`,
    stepOptsFor(node),
    async () => {
      const rc = runContextFor(p, env)
      const toolDeps = await config.buildRunDeps(rc)
      const itemResult = await executeSubgraph(
        node.config.subgraph,
        item,
        {
          getModel: (modelId, opts) => {
            return config.getModel(modelId, {
              ...rc,
              reasoning: opts?.reasoning,
            })
          },
          getDecider: config.getDecider
            ? (modelId) => config.getDecider!(modelId, rc)
            : undefined,
          toolRegistry: config.toolRegistry,
          toolDeps,
          modelBudget: modelBudgetFor(resolveStepTimeoutMs(node)),
          // Overridden per item inside executeSubgraph.
          nodeOutputs: new Map(),
          promptVariables: p.runContext.promptVariables,
          manifest,
          sink: itemSink,
          resolveBlobRef: config.resolveBlobRef,
          simulate: p.runContext.simulate,
          fixtures: p.runContext.fixtures,
          liveReads: p.runContext.liveReads,
          toolModes: p.runContext.toolModes,
          freezeTools: p.runContext.freezeTools,
          agentOverride: p.runContext.agentOverride,
        },
        // Record each inner node once per item. The recorder is
        // built inside this `iter:` step.do closure (a D1 binding
        // can't cross a step boundary); the whole closure replays
        // on retry, and the `(run_id, node_id, item_index)` upsert
        // makes that replay idempotent.
        {
          recorder: createTelemeteredRecorder({
            db: createWfDb(env.WF_DB),
            runId: p.workflowRunId,
            telemetry: ctx.telemetry,
            dims: ctx.dims,
            prices: ctx.prices,
            logger: ctx.logger,
          }),
          parentNodeId: node.id,
          itemIndex: index,
        },
      )
      // This return IS the boundary: one item's whole subgraph result is
      // journaled as this step's output. Spilling here is also what keeps the
      // collection below small, since the collection is these returns.
      return await spillAtBoundary(
        config,
        toolDeps,
        {
          runId: p.workflowRunId,
          nodeId: node.id,
          itemIndex: index,
          slot: 'iteration-item',
        },
        itemResult,
      )
    },
  )
}

/**
 * One item, run as its own child workflow instance: spawn, then park until it
 * reports back.
 *
 * This is `dispatchCallee` one level down. Same handshake (spawn → park →
 * event, never poll — a parked instance is hibernated and free), same reason:
 * the item's inner nodes get real durable steps, their own declared retries and
 * timeouts, and a resumable run each, instead of one all-or-nothing step whose
 * failure replays the whole item's side effects.
 *
 * NOT wrapped in a `run:` step, and neither is the iteration around it — nothing
 * here may nest inside a `step.do`, which is the whole point.
 *
 * One semantic difference from an inline item, deliberate and inherited from
 * what a RUN means here: a child reports the moment its Output is reached
 * (`deliverOutput`), while arms that don't feed the Output keep draining behind
 * it. An inline item drains before `executeSubgraph` returns. So under durable
 * items, "the loop finished" means every item ANSWERED, not that every item's
 * background side effects have landed. That is exactly how the top-level run
 * already behaves for its own host, and how `dispatchCallee` already
 * behaves for a workflow-call node — releasing a waiter behind a branch it never
 * depended on would be the odd choice, not this.
 *
 * Concurrency and stop-on-error are NOT implemented here. `runIteration`'s
 * worker pool already bounds how many of these are in flight and already drains
 * on failure (no new spawns; those already running are awaited before the node
 * fails), so this function is only ever one item. See NEW-174 and
 * `iteration-durable-semantics.test.ts`.
 */
async function runItemAsChildInstance<TDeps, E extends GraphWorkflowEnv>(
  ctx: RunCtx<TDeps, E>,
  node: IterationNode,
  item: unknown,
  index: number,
): Promise<unknown> {
  const { step, env, p, manifest, instanceId, traceId } = ctx
  // Per ITEM, not per node: two children of the same iteration must not park on
  // one type, or whichever finished first would wake both waiters and hand each
  // the wrong item's output — a silent mix-up rather than a failure. Built here
  // (not inside the spawn step) so an id that can't make a valid event type
  // fails before anything is created.
  const eventType = calleeEventType(node.id, index)

  // The child's `wf_run` and its instance in ONE journaled step, so a replay
  // reuses both rather than minting a second run and a second orphan instance.
  // `crypto.randomUUID()` is safe inside a step for exactly that reason.
  const spawned = await stepDo(
    step,
    `spawn:${node.id}:${index}`,
    DEFAULT_STEP_OPTS,
    async () => {
      const childRunId = await createRun(createWfDb(env.WF_DB), {
        workflowVersionId: p.workflowVersionId,
        triggerKind: p.runContext.triggerKind,
        subjectId: p.runContext.subjectId,
        correlationId: p.runContext.correlationId,
        actorId: p.runContext.actorId,
        // An eval's items are eval runs too — every dashboard query filters
        // `is_eval = false`, so an unmarked child would be counted where its
        // parent is excluded.
        isEval: p.runContext.isEval,
        sentryTraceId: traceId,
        // Read from THIS deploy's env rather than copied off the parent row:
        // the item runs on whatever is deployed when it is spawned, which after
        // a resume-across-deploy is not what the parent started on.
        ...releaseFromEnv(env),
        // What nests this item under its parent in the run viewer, and the only
        // link that survives the parent finishing. See NEW-172.
        parent: {
          runId: p.workflowRunId,
          nodeId: node.id,
          itemIndex: index,
          // Resolved HERE because this is the last place the item's value and
          // the container's template are both in hand — the child instance
          // gets the item, but not the node that spawned it.
          itemTitle: iterationItemTitle(node.config.itemTitle, item, {
            index,
          }),
        },
      })
      const instance = await env.GRAPH_WORKFLOW.create({
        params: iterationItemParams({
          parent: p,
          manifest,
          parentInstanceId: instanceId,
          nodeId: node.id,
          item,
          eventType,
          childRunId,
          roomId: crypto.randomUUID(),
        }),
      })
      return { childRunId, instanceId: instance.id }
    },
  )

  // Park. The timeout is the node's own declared step timeout — the same knob
  // that bounds an inline item — so a child that dies without ever reporting
  // surfaces as a legible timeout rather than a permanently stuck run.
  const settled = await step.waitForEvent<CalleeDoneWire>(
    `await:${node.id}:${index}`,
    { type: eventType, timeout: resolveStepTimeoutMs(node) },
  )

  if (!settled.payload.ok) {
    // Not retryable: a retry would spawn a whole second child for this item and
    // the first one's side effects have already happened. `runIteration` decides
    // what this does to the rest of the loop — a placeholder in this item's slot,
    // or a drain — according to `stopOnError`.
    throw new NonRetryableError(
      `Item ${index} of iteration "${node.label}" failed (run ${spawned.childRunId}): ${settled.payload.error}`,
    )
  }

  // The child spilled a large output to R2 inside its own run and reported the
  // POINTER, so this crosses the 1 MiB event cap the same way the inline path's
  // `spillAtBoundary` return crosses the step-return cap — and lands in the
  // collection in the same shape. Downstream nodes rehydrate inside their own
  // steps either way.
  return JSON.parse(settled.payload.outputJson)
}
