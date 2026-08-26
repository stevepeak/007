import { NonRetryableError } from 'cloudflare:workflows'

import {
  apiErrorDetail,
  errorFeedLine,
  errorStored,
} from '../engine/error-detail'
import {
  isDecisionKind,
  workflowFromManifest,
  type IterationNode,
  type WorkflowCallNode,
} from '../engine/graph'
import { modelBudgetFor } from '../engine/model-budget'
import { nodeSpanLabel } from '../engine/node-label'
import { emitNodeStartProgress } from '../engine/node-progress'
import { isFatalAgentError } from '../engine/nodes/agent-generation'
import {
  executeSubgraph,
  IterationTooManyItemsError,
  resolveIterationList,
  runIteration,
} from '../engine/nodes/iteration'
import { buildCalleeTriggerInput } from '../engine/nodes/workflow'
import { errorMessage, runNode, type NodeRunResult } from '../engine/run-node'
import { recordedBranchResult } from '../engine/run-recorder'
import type { ExecutableNode, ReportResult } from '../engine/scheduler'
import {
  withoutUserProgress,
  type RunLogEntry,
  type StreamSink,
} from '../engine/stream-sink'
import { enforceOutputContract } from '../engine/trigger-registry'
import { createWfDb } from '../storage/client'
import {
  appendRunLog,
  completeRun,
  countNodeBodyLogs,
  createRun,
  markRunDone,
  replaceNodeLogs,
  type WfRunLogRow,
} from '../storage/data'

import {
  assertValidEventType,
  calleeEventType,
  toCalleeWire,
  type CalleeDoneEvent,
  type CalleeDoneWire,
} from './callee-protocol'
import type { GraphWorkflowEnv, GraphWorkflowResult } from './graph-workflow'
import {
  nodeLabel,
  ownsItsDurableSteps,
  startEntryOf,
  recordTerminal,
} from './graph-workflow-dispatch-logs'
import type { RunCtx } from './graph-workflow-dispatch-run-ctx'
import {
  rehydrateAtBoundary,
  spillAtBoundary,
  spillNodeOutputs,
} from './graph-workflow-dispatch-spill'
import { notifyHost, stepDo } from './graph-workflow-dispatch-step'
import {
  DEFAULT_STEP_OPTS,
  resolveStepTimeoutMs,
  stepOptsFor,
} from './graph-workflow-dispatch-step-opts'
import {
  createTelemeteredRecorder,
  emitRunPoint,
} from './graph-workflow-telemetry'
import { withNodeSpan } from './tracing'

// Re-export the extracted helpers so every symbol that historically lived in
// this module stays importable from `./graph-workflow-dispatch`.
export {
  AI_STEP_OPTS,
  DEFAULT_STEP_OPTS,
} from './graph-workflow-dispatch-step-opts'
export { notifyHost, stepDo } from './graph-workflow-dispatch-step'
export type { RunCtx } from './graph-workflow-dispatch-run-ctx'

// The run: step returns the engine's NodeRunResult plus the structured
// log entries the node emitted during its own step (captured by a per-node
// sink), so they survive `step.do` replay via the workflow journal.
// `execStartedAt`/`execFinishedAt` bracket the actual `runNode` call (measured
// inside the run: step, so they're journaled) — this is the true execution
// window the Speed stat reads, as opposed to the wider dispatch envelope that
// spans the enter:/run:/record: durable-step boundaries.
type RunStepResult = NodeRunResult & {
  logs?: RunLogEntry[]
  execStartedAt?: Date
  execFinishedAt?: Date
}

// Run one iteration node. Iteration orchestrates its own per-item durable
// steps, so it is NOT wrapped in a single `run:` step — `step.do` calls can't
// nest. Each item's subgraph runs inside its own top-level `iter:` step
// (deterministic name = node id + index → replay-safe); the outer
// `runIteration` only awaits those steps under its concurrency pool and
// collects the ordered results. The whole iteration is still recorded as ONE
// run-step by the caller (output = the collection).
async function dispatchIteration<TDeps, E extends GraphWorkflowEnv>(
  ctx: RunCtx<TDeps, E>,
  node: IterationNode,
  /** The node's own feed writer, built by the caller (there is no `run:` step
   * here to host one). Carries the loop's note and per-item ticks. */
  nodeSink: StreamSink,
): Promise<RunStepResult> {
  const { step, env, config, p, manifest, scheduler } = ctx
  // The loop speaks for its whole body. Its subgraph gets the run-level sink
  // with USER-facing lines stripped: a step inside a loop has nowhere to be
  // shown — the feed is one flat list — so it stays quiet until there is a
  // per-item surface for it. Its dev trace is unaffected.
  const itemSink = withoutUserProgress(ctx.sink)
  if (node.config.itemExecution === 'durable') {
    // Per-item child instances are not wired up yet. Failing loudly beats
    // silently running inline: the author chose this setting precisely because
    // an item repeating from the start is unacceptable to them, and a quiet
    // downgrade would hand them exactly that with no way to notice.
    throw new NonRetryableError(
      `Iteration "${node.label}" is set to Durable item execution, which is not available yet. Switch it back to Inline to run this workflow.`,
    )
  }
  // The fan-out fence throws before a single `iter:` step is spawned, and the
  // list it rejected is the same list every replay resolves — retrying only
  // spends the budget the fence just refused. Escalate it the same way the
  // durable-mode guard above does.
  const iter = await runIteration({
    node,
    // List is a ref into an upstream output, resolved against the
    // scheduler's global outputs — not the forwarded input.
    list: resolveIterationList(node, scheduler.getOutputs()),
    sink: nodeSink,
    promptVariables: p.runContext.promptVariables,
    runItem: (item, index) =>
      // The iteration node creates no `run:` step of its own — these per-item
      // steps are the only ones it has, so its `execution` policy governs ONE
      // ITEM. `stepOptsFor` and `resolveStepTimeoutMs` below read that same
      // policy, which is what keeps the item's wall-clock timeout and the
      // in-process budget derived from it in agreement.
      stepDo(step, `iter:${node.id}:${index}`, stepOptsFor(node), async () => {
        const rc = { ...p.runContext, env }
        const toolDeps = await config.buildRunDeps(rc)
        const itemResult = await executeSubgraph(
          node.config.subgraph,
          item,
          {
            getModel: (modelId, opts) =>
              config.getModel(modelId, { ...rc, reasoning: opts?.reasoning }),
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
          { runId: p.workflowRunId, nodeId: node.id, itemIndex: index, slot: 'iteration-item' },
          itemResult,
        )
      }),
  }).catch((err: unknown) => {
    if (err instanceof IterationTooManyItemsError) {
      throw new NonRetryableError(err.message)
    }
    throw err
  })
  // The main step multiplier: an iteration spends one `iter:` step per item
  // instead of a single `run:`, so a wide list is what makes a graph expensive.
  // `iter.meta.total` is journaled, so this re-accumulates identically on replay.
  ctx.counters.iterationItems += iter.meta.total
  return {
    schedulerOutput: iter.results,
    recordedOutput: iter.results,
    meta: iter.meta,
  }
}

// ── Durable callees ─────────────────────────────────────────────────────────
//
// A workflow-call node set to `calleeExecution: 'durable'` runs its callee as a
// CHILD workflow instance instead of inlining it into this node's single step.
// The callee then gets what the inline path can't give it: one durable step per
// node, per-node retries and timeouts, and a resumable run of its own.
//
// The handshake is spawn → park → event, not spawn → poll: an instance parked on
// `waitForEvent` is hibernated and does NOT count against the concurrency cap,
// so a parent waiting on a long callee costs nothing. Polling would burn a step
// per check and keep the parent resident.

/**
 * Tell the waiting parent this callee settled. No-op for an ordinary run.
 *
 * Runs in its own durable step: the parent is parked indefinitely (up to the
 * node's timeout) and this is the only thing that will ever wake it, so it has
 * to survive the same retries every other write does.
 */
export async function reportToParent<TDeps, E extends GraphWorkflowEnv>(
  ctx: RunCtx<TDeps, E>,
  payload: CalleeDoneEvent,
): Promise<void> {
  const sub = ctx.p.subRun
  if (!sub) {
    return
  }
  const wire = toCalleeWire(payload)
  await stepDo(ctx.step, 'report-to-parent', DEFAULT_STEP_OPTS, async () => {
    // Check the type before sending. An invalid one is rejected by the platform
    // and retried on the standard backoff for hours, while the parent shows only
    // a generic timeout — so this is the one place that can name the real cause,
    // and retrying it can never help.
    try {
      assertValidEventType(sub.eventType, 'Reporting to parent workflow')
    } catch (err) {
      throw new NonRetryableError(errorMessage(err))
    }
    const parent = await ctx.env.GRAPH_WORKFLOW.get(sub.parentInstanceId)
    await parent.sendEvent({ type: sub.eventType, payload: wire })
    return null
  })
}

/**
 * Run a workflow-call node by spawning its callee as a child instance and
 * parking until it reports back.
 *
 * Like `dispatchIteration` this is NOT wrapped in a `run:` step — `step.do` and
 * `waitForEvent` can't nest inside another step, and the whole point is for the
 * callee's nodes to own steps of their own.
 */
async function dispatchDurableCallee<TDeps, E extends GraphWorkflowEnv>(
  ctx: RunCtx<TDeps, E>,
  node: WorkflowCallNode,
  input: unknown,
): Promise<RunStepResult> {
  const { step, env, p, manifest, scheduler, instanceId, traceId } = ctx
  const entry = workflowFromManifest(manifest, node.config.workflowId)
  if (!entry) {
    throw new NonRetryableError(
      `Workflow node ${node.id} references workflow ${
        node.config.workflowId || '(none)'
      }, which is not in the run manifest.`,
    )
  }

  const triggerInput = buildCalleeTriggerInput(
    node,
    input,
    scheduler.getOutputs(),
  )
  const eventType = calleeEventType(node.id)

  // Create the callee's own `wf_run` and its instance in ONE journaled step, so
  // a replay reuses both rather than minting a second run and a second instance.
  // `crypto.randomUUID()` is safe here for exactly that reason — inside the step,
  // never in the orchestrator.
  const spawned = await stepDo(
    step,
    `spawn:${node.id}`,
    DEFAULT_STEP_OPTS,
    async () => {
      const childRunId = await createRun(createWfDb(env.WF_DB), {
        workflowVersionId: entry.versionId,
        triggerKind: p.runContext.triggerKind,
        subjectId: p.runContext.subjectId,
        correlationId: p.runContext.correlationId,
        // The callee acts for the same principal as its caller — carried onto
        // the child row so a failure inside a spawned sub-run is attributable
        // without walking back to the parent.
        actorId: p.runContext.actorId,
        // Same trace as the parent, so the callee's spans land in one
        // distributed trace instead of a detached second one.
        sentryTraceId: traceId,
        // The nesting link the run viewer reads to show this callee UNDER its
        // caller. A workflow-call node spawns exactly one callee, so it takes
        // the top-level item sentinel; durable iteration items pass a real
        // 0-based index instead.
        parent: { runId: p.workflowRunId, nodeId: node.id },
      })
      const childRoomId = crypto.randomUUID()
      const instance = await env.GRAPH_WORKFLOW.create({
        params: {
          runId: childRoomId,
          workflowRunId: childRunId,
          workflowVersionId: entry.versionId,
          triggerInput,
          // The callee inherits the caller's context wholesale — deps, prompt
          // variables, and the eval signals — so its tools behave exactly as
          // they did when it ran inline.
          runContext: p.runContext,
          inheritedManifest: manifest,
          subRun: { parentInstanceId: instanceId, eventType },
        },
      })
      return { childRunId, instanceId: instance.id }
    },
  )

  // Park. The timeout is the node's own declared step timeout, so the author's
  // one knob still bounds the callee — and a child that dies without ever
  // reporting surfaces as a legible timeout instead of a permanently stuck run.
  const settled = await step.waitForEvent<CalleeDoneWire>(`await:${node.id}`, {
    type: eventType,
    timeout: resolveStepTimeoutMs(node),
  })

  const meta = {
    workflowId: entry.id,
    versionId: entry.versionId,
    versionNumber: entry.versionNumber,
    name: entry.name,
    // The link the run viewer needs to offer a drill-down into the callee's own
    // trace — the durable path's answer to the inline path's per-item rows.
    childRunId: spawned.childRunId,
    calleeExecution: 'durable' as const,
  }

  if (!settled.payload.ok) {
    // The callee already recorded its own failure against its own run; this is
    // the parent's copy of why its node failed. Not retryable: retrying would
    // spawn a whole second callee run, and the first one's side effects have
    // already happened.
    throw new NonRetryableError(
      `Called workflow "${entry.name}" failed: ${settled.payload.error}`,
    )
  }

  const output: unknown = JSON.parse(settled.payload.outputJson)
  return {
    schedulerOutput: output,
    recordedOutput: output,
    meta,
  }
}

/** What a failed attempt knew about its error, captured before the error
 * crosses the `step.do` boundary (see `runNodeBody`). */
type CapturedFailure = { stored: string; feed: string }

/** The node's configured step timeout, phrased for the run feed. */
function describeStepTimeout(node: ExecutableNode): string {
  const ms = resolveStepTimeoutMs(node)
  const minutes = ms / 60_000
  return minutes >= 1
    ? `${Number(minutes.toFixed(1))} min`
    : `${Math.round(ms / 1000)}s`
}

// Run a node's body, capturing what went wrong while the real error object is
// still in hand and cutting the retry loop short when retrying is pointless.
//
// Three problems, all of which read to a user as "it hung":
//
//  1. Detail loss. Cloudflare RECONSTRUCTS an error thrown out of `step.do` —
//     the value the caller catches is a fresh Error carrying only a message and
//     stack. `APICallError`'s status code and provider response body (the part
//     that actually says *why*) never survive the crossing, so the outer catch
//     could only ever store a stack. Capturing here, inside the step, is the
//     only place that detail still exists.
//
//  2. Pointless retrying. `AI_STEP_OPTS` retries with exponential backoff,
//     which is right for a 429/503 and useless for "Payment Required" or a bad
//     model id — the same rejection just arrives minutes later. The AI SDK
//     already classifies this (`APICallError.isRetryable`), so a non-retryable
//     provider error is escalated to `NonRetryableError` and fails now.
//
//  3. Silence between attempts. A retryable failure is followed by a backoff
//     and another attempt; without a line here, that whole window is blank and
//     the node's closing `✕` line only ever reports the LAST attempt.
async function runNodeBody<T>(
  sink: StreamSink,
  onFailure: (captured: CapturedFailure) => void,
  body: () => Promise<T>,
): Promise<T> {
  try {
    return await body()
  } catch (err) {
    const feed = errorFeedLine(err)
    onFailure({ stored: errorStored(err), feed })
    const detail = apiErrorDetail(err)
    // A node that burned its ENTIRE budget — or ran its whole loop without
    // writing an answer — is not worth retrying: the retry repeats the same
    // work against the same wall, costing another full window of wall-clock to
    // reach the same non-answer. A single stalled round-trip or tool call is
    // the opposite — transient, and it falls through to the retry path below.
    if (isFatalAgentError(err)) {
      throw new NonRetryableError(feed)
    }
    if (detail?.isRetryable === false) {
      // Fatal: the node's closing `✕ … failed: <feed>` line already reports
      // this, so don't also log it inline — one failure, one line.
      throw new NonRetryableError(feed)
    }
    // Retryable: another attempt is coming and will overwrite the capture
    // above, so this line is the only trace this attempt ever happened.
    void sink.log?.({ level: 'warn', message: `${feed} — retrying` })
    throw err
  }
}

// Execute one node in its own durable `run:`/`record:` steps and return
// what the scheduler needs. Run and record are SEPARATE steps: fusing them
// means a failed *record* write re-runs the entire body on retry — and
// `step.do` retries replay the whole closure — so a transient DB hiccup
// would re-invoke the model and any side-effecting tools. Split, the record
// step retries on its own while the node's (already-successful) result
// replays from the workflow journal. A failed node records its own failed
// step (so it can't re-run the body) and rethrows.
export async function dispatchNode<TDeps, E extends GraphWorkflowEnv>(
  ctx: RunCtx<TDeps, E>,
  node: ExecutableNode,
  input: unknown,
  seq: number,
): Promise<{ nodeId: string; report: ReportResult }> {
  const { step, env, config, p, manifest, sink, scheduler, traceId } = ctx
  const startTs = Date.now()
  const startEntry = startEntryOf(node, seq, startTs)

  const startRow: WfRunLogRow = {
    nodeId: node.id,
    nodeKind: node.kind,
    sequence: seq,
    level: startEntry.level,
    message: startEntry.message,
    meta: null,
    ts: startTs,
  }

  // Light the node up (status → running), persist the "entered" line, and
  // stream it live — all in one durable step so a replay doesn't
  // re-broadcast. Persisting node-start HERE (not just at record time)
  // means a polling run viewer sees the feed advance the instant a node
  // starts, in step with the glow, rather than a whole node behind. The
  // record step below flips this same (run_id, node_id) row to its
  // terminal status and rewrites the node's full feed.
  const selfStepping = ownsItsDurableSteps(node)
  await stepDo(step, `enter:${node.id}`, DEFAULT_STEP_OPTS, async () => {
    await ctx.recordOne({
      nodeId: node.id,
      nodeKind: node.kind,
      sequence: seq,
      input,
      status: 'running',
      startedAt: new Date(startTs),
    })
    const logDb = createWfDb(env.WF_DB)
    // A self-stepping node's feed is written by position-keyed upsert from end
    // to end (see `ownsItsDurableSteps`), so its opening line takes the `start`
    // slot here and the record step rewrites that same row. Every other node
    // replaces its feed wholesale, which is what clears it for a fresh run.
    if (selfStepping) {
      await appendRunLog(logDb, {
        runId: p.workflowRunId,
        nodeId: node.id,
        ordinal: 'start',
        entry: startRow,
      })
    } else {
      await replaceNodeLogs(logDb, {
        runId: p.workflowRunId,
        nodeId: node.id,
        entries: [startRow],
      })
    }
    return null
  })

  let result: RunStepResult
  // Hoisted OUT of the `run:` closure below so the entries a node emitted
  // survive it THROWING. Kept inside, a failed node's trace died with the
  // closure and the feed showed only "▶ node" … "✕ node failed" — no sign of
  // the ten tool calls it made first. Each attempt resets it (see below), so
  // after a throw this holds exactly the failed attempt's entries.
  const bodyLogs: RunLogEntry[] = []
  // Likewise hoisted: the failing attempt's error detail, captured inside the
  // step where the real error object still exists (Cloudflare rebuilds it on
  // the way out, dropping everything but message + stack).
  let captured: CapturedFailure | null = null
  // The feed writer for a node that drives durable steps of its OWN (see
  // `ownsItsDurableSteps`): there is no `run:` step to host a per-node sink, so
  // it is built HERE, in the orchestrator body. That placement is the whole
  // reason its writes are position-keyed — the body is NOT journaled, so every
  // replay of the instance re-emits these same lines, and only an upsert onto a
  // deterministic slot keeps a replay from stacking a second copy of the node's
  // narration onto the feed. `bodyLogs` collects the same entries so the record
  // step settles them in those same slots; a replay refills it on the way past,
  // so a feed written here survives that rewrite.
  //
  // Without this the lines went to the run-level sink, which persists nothing —
  // an iteration's `Reading each recipe — ${n} in total.` was authored,
  // emitted, and dropped on the floor (ART-25).
  const selfSteppingSink = (): StreamSink => {
    const logDb = createWfDb(env.WF_DB)
    return {
      log: (entry) => {
        const e: RunLogEntry = {
          ...entry,
          ts: entry.ts ?? Date.now(),
          nodeId: entry.nodeId ?? node.id,
          nodeKind: entry.nodeKind ?? node.kind,
          sequence: entry.sequence ?? seq,
        }
        const ordinal = bodyLogs.length
        bodyLogs.push(e)
        // Best-effort, exactly as in the `run:` sink: a dropped progress line
        // must never fail the node that was merely narrating itself.
        void appendRunLog(logDb, {
          runId: p.workflowRunId,
          nodeId: node.id,
          ordinal,
          entry: {
            nodeId: e.nodeId ?? node.id,
            nodeKind: e.nodeKind ?? node.kind,
            sequence: e.sequence ?? seq,
            level: e.level,
            message: e.message,
            meta: e.meta ?? null,
            ts: e.ts ?? Date.now(),
          },
        }).catch((err: unknown) => {
          console.error('[wf] live log append failed:', err)
        })
        return sink.log?.(e)
      },
    }
  }

  try {
    if (node.kind === 'iteration') {
      // No progress emit here: an iteration's note needs the item count, which
      // only exists once the list is resolved inside `runIteration` — that's
      // where both its note and its per-item lines are emitted.
      result = await dispatchIteration(ctx, node, selfSteppingSink())
    } else if (
      node.kind === 'workflow' &&
      node.config.calleeExecution === 'durable'
    ) {
      // Same reason as iteration: this node drives durable steps of its own
      // (spawn + waitForEvent), which can't live inside a `run:` step.
      const nodeSink = selfSteppingSink()
      emitNodeStartProgress(nodeSink, node, p.runContext.promptVariables)
      result = await dispatchDurableCallee(ctx, node, input)
    } else {
      result = await stepDo(
        step,
        `run:${node.id}`,
        stepOptsFor(node),
        async () => {
          const rc = { ...p.runContext, env }
          const toolDeps = await config.buildRunDeps(rc)
          // Bound the node's model work from INSIDE the step, derived from the
          // very timeout Cloudflare would otherwise enforce from outside. The
          // in-process budget is strictly shorter, so it always wins the race —
          // turning a silent external kill into a caught, logged, attributable
          // failure.
          const modelBudget = modelBudgetFor(resolveStepTimeoutMs(node))
          // Every `step.do` ATTEMPT replays this closure from the top, so reset
          // the shared buffer and the emit counter here: a retry then rewrites
          // the same deterministic rows rather than appending a second copy of
          // the node's feed. Clearing the previously persisted body rows too
          // keeps a shorter retry from stranding the last attempt's tail.
          bodyLogs.length = 0
          captured = null
          const logDb = createWfDb(env.WF_DB)
          // Rows this node already appended — from an EARLIER ATTEMPT, since
          // `step.do` replays the whole closure. Used as this attempt's ordinal
          // base so its rows land in a fresh id range instead of overwriting
          // the previous attempt's account of what it was doing when it died.
          let ordinal = await countNodeBodyLogs(logDb, {
            runId: p.workflowRunId,
            nodeId: node.id,
          })
          const isRetry = ordinal > 0
          // Per-node sink: every structured entry a node handler emits (agent
          // reasoning, tool calls, our own info lines) is (a) persisted to
          // `wf_run_log` IMMEDIATELY and (b) buffered for the terminal rewrite.
          // (a) is what makes a run observable while it runs — every consumer
          // polls the persisted feed, so without it a node is invisible until
          // it finishes.
          const nodeSink: StreamSink = {
            log: (entry) => {
              const e: RunLogEntry = {
                ...entry,
                ts: entry.ts ?? Date.now(),
                nodeId: entry.nodeId ?? node.id,
                nodeKind: entry.nodeKind ?? node.kind,
                sequence: entry.sequence ?? seq,
              }
              bodyLogs.push(e)
              // Best-effort: a dropped progress line must never fail the node
              // that was merely narrating itself. The terminal rewrite in
              // `record:` restores anything lost here.
              const ord = ordinal++
              void appendRunLog(logDb, {
                runId: p.workflowRunId,
                nodeId: node.id,
                ordinal: ord,
                entry: {
                  nodeId: e.nodeId ?? node.id,
                  nodeKind: e.nodeKind ?? node.kind,
                  sequence: e.sequence ?? seq,
                  level: e.level,
                  message: e.message,
                  meta: e.meta ?? null,
                  ts: e.ts ?? Date.now(),
                },
              }).catch((err: unknown) => {
                console.error('[wf] live log append failed:', err)
              })
              return sink.log?.(e)
            },
          }
          // A restart is the single most confusing thing a run can do: the node
          // silently begins again and repeats work already in the feed. Mark
          // the boundary explicitly, and name the most likely cause — the step
          // timeout, which kills the closure from OUTSIDE, so `runNodeBody`'s
          // catch never runs and no error line is ever emitted for it.
          if (isRetry) {
            void nodeSink.log?.({
              level: 'warn',
              message:
                `⟲ Restarting ${nodeLabel(node)} — the previous attempt ended without finishing ` +
                `(step timeout: ${describeStepTimeout(node)}). Everything above this line is from the abandoned attempt.`,
            })
          }
          // First-class user-facing line, first in the node's body feed (so the
          // terminal rewrite persists it): the author's progress note, if any.
          emitNodeStartProgress(nodeSink, node, p.runContext.promptVariables)
          // Bracket the real execution here — inside the run: step, right
          // around runNode — so the persisted Speed reflects actual work, not
          // the durable-step envelope. Journaled with the return value, so it
          // replays deterministically.
          const execStartedAt = new Date()
          const r = await runNodeBody(
            nodeSink,
            (c) => {
              captured = c
            },
            () =>
              withNodeSpan(
                {
                  traceId,
                  runId: p.workflowRunId,
                  nodeId: node.id,
                  nodeKind: node.kind,
                  sequence: seq,
                  label: nodeSpanLabel(node, manifest),
                  actorId: p.runContext.actorId,
                  subjectId: p.runContext.subjectId,
                  correlationId: p.runContext.correlationId,
                },
                () =>
                  runNode(
                    { type: 'execute', node, input },
                    {
                      // Bridge the per-call reasoning intent through to the
                      // host. Dropping `opts` here made `ModelFactory`'s
                      // contract a lie on the production path — nothing passes
                      // an intent today (so this stays undefined and the
                      // provider default wins), but a future caller must not
                      // silently have it ignored. There is no run-level
                      // reasoning on this path to fall back to: `start-run.ts`
                      // never sets one.
                      getModel: (modelId, opts) =>
                        config.getModel(modelId, {
                          ...rc,
                          reasoning: opts?.reasoning,
                        }),
                      toolRegistry: config.toolRegistry,
                      toolDeps,
                      modelBudget,
                      nodeOutputs: scheduler.getOutputs(),
                      promptVariables: p.runContext.promptVariables,
                      manifest,
                      sink: nodeSink,
                      resolveBlobRef: config.resolveBlobRef,
                      simulate: p.runContext.simulate,
                      fixtures: p.runContext.fixtures,
                      liveReads: p.runContext.liveReads,
                      freezeTools: p.runContext.freezeTools,
                      agentOverride: p.runContext.agentOverride,
                      // Delegation: an agent node may spawn sub-agents/workflows
                      // inline and record each as a child step. Built inside this
                      // `run:` closure (a D1 binding can't cross a step boundary);
                      // the whole closure replays on retry and the
                      // `(run_id, node_id, item_index)` upsert makes that idempotent.
                      subStepRecorder:
                        node.kind === 'agent'
                          ? createTelemeteredRecorder({
                              db: createWfDb(env.WF_DB),
                              runId: p.workflowRunId,
                              telemetry: ctx.telemetry,
                              dims: ctx.dims,
                              prices: ctx.prices,
                            })
                          : undefined,
                    },
                  ),
              ),
          )
          // Last thing before the value crosses the durable boundary: anything
          // too big to journal is written out and replaced by a pointer. Inside
          // the closure on purpose — out here the payload would already have
          // had to survive the crossing we're protecting.
          const outputs = await spillNodeOutputs(
            config,
            toolDeps,
            {
              runId: p.workflowRunId,
              nodeId: node.id,
              slot: 'node-output',
            },
            r,
          )
          return {
            ...r,
            ...outputs,
            logs: bodyLogs,
            execStartedAt,
            execFinishedAt: new Date(),
          }
        },
      )
    }
  } catch (err) {
    // Prefer what the attempt captured on its way out: `err` here has been
    // rebuilt by the workflow runtime and is a stack with no provider detail.
    const failure: CapturedFailure = captured ?? {
      stored: errorStored(err),
      feed: errorFeedLine(err),
    }
    ctx.counters.failedNodes++
    await recordTerminal(ctx, node, seq, input, startEntry, {
      status: 'failed',
      error: failure.stored,
      feed: failure.feed,
      // Whatever the failed attempt managed to emit before it threw. Without
      // this a failed node's whole trace is discarded and the feed collapses to
      // two lines — exactly when the trace matters most.
      bodyLogs,
    })
    // Best-effort node: swallow the failure and let the run continue with a
    // `null` output (downstream refs resolve to null). Never for decision
    // nodes — a routing decision has no safe default, so it must still
    // abort. The failed step above keeps the failure visible in the trace.
    if (node.execution?.continueOnError && !isDecisionKind(node.kind)) {
      return { nodeId: node.id, report: { output: null } }
    }
    throw err
  }

  await recordTerminal(ctx, node, seq, input, startEntry, {
    status: 'completed',
    output: result.recordedOutput,
    meta: result.meta,
    branchResult: recordedBranchResult(result),
    // `logs` is the `run:` step's journaled copy — the same array, returned
    // through the step so it survives replay. A self-stepping node has no such
    // step and fills `bodyLogs` directly.
    bodyLogs: result.logs ?? bodyLogs,
    startedAt: result.execStartedAt,
    finishedAt: result.execFinishedAt,
  })

  return {
    nodeId: node.id,
    report: {
      output: result.schedulerOutput,
      branchResult: result.branchResult,
    },
  }
}

// Deliver a run's answer: persist the output, wake a waiting parent, and
// best-effort notify the host. Shared by the two success
// exits — a reached Output (with its node id) and a decision that fizzled
// out (output `undefined`, no node id).
//
// This makes the run `done`, NOT `completed`. Arms that don't feed the Output
// keep executing behind it and `settleRun` closes the run out when they finish;
// `pendingWork` is what tells the two apart, and under the rolling walk it must
// count nodes that are RUNNING as well as ready (see `Scheduler.hasPendingWork`)
// — the background arms are mid-flight at this exact moment. Everyone waiting on
// an answer — the host callback, a parent workflow parked on a callee — is
// released here rather than behind a background arm they never depended on.
export async function deliverOutput<TDeps, E extends GraphWorkflowEnv>(
  ctx: RunCtx<TDeps, E>,
  rawOutput: unknown,
  outputNodeId: string | null,
  pendingWork: boolean,
): Promise<GraphWorkflowResult> {
  const { step, env, config, p, scheduler } = ctx
  // Enforce the trigger's output contract (e.g. chat's `{ text }`) before we
  // persist anything: a run whose Output was bound to the wrong shape — or that
  // fizzled out with no result under a contract that requires one — fails here
  // (the caller's catch records the failure) rather than the host reading an
  // empty result. Contract-less triggers pass through.
  // A spawned callee skips the contract for the same reason it skips trigger
  // validation: the inline path it replaces enforces neither, and flipping
  // `calleeExecution` must not change whether a workflow is allowed to finish.
  // The PARENT's own Output still answers to its own trigger's contract.
  //
  // A large answer arrives here as a blob pointer (see
  // `graph-workflow-dispatch-spill`), and the contract is a Zod check that
  // would reject the pointer's shape, so both the check and the write need the
  // value read back. That read is R2 I/O, which cannot happen out here: this
  // body re-executes on every wake, and a non-deterministic call in it would
  // re-run once per hibernation. So `answerFor` does the read INSIDE whichever
  // step needs it — and the pointer, not the payload, is what this function
  // returns, since the instance result has a size cap of its own and `wf_run`
  // is where the host reads the answer from anyway.
  const answerFor = async (): Promise<unknown> => {
    const answer = p.subRun
      ? rawOutput
      : await rehydrateAtBoundary(
          config,
          () => config.buildRunDeps({ ...p.runContext, env }),
          rawOutput,
        )
    if (p.subRun) return answer
    try {
      return enforceOutputContract(
        config.triggers,
        scheduler.trigger.config.triggerKind,
        answer,
      )
    } catch (err) {
      // The contract cannot come out true on a retry — the graph is bound the
      // way it is bound. Retrying would spend the node's whole backoff
      // schedule re-deriving the same rejection, so fail now and let the
      // caller's catch record it, exactly as it did when this check ran in the
      // orchestrator body.
      throw new NonRetryableError(
        err instanceof Error ? err.message : String(err),
      )
    }
  }
  await stepDo(step, 'finalize', async () =>
    await markRunDone(createWfDb(env.WF_DB), {
      runId: p.workflowRunId,
      output: await answerFor(),
      settled: !pendingWork,
      pendingNodes: scheduler.inFlightCount(),
    }),
  )
  // The callee reports its pointer as-is: the parent hands it to a node that
  // rehydrates inside its own step, so the payload never touches the 1 MiB
  // event cap. `rawOutput` is already contract-free for a sub-run.
  await reportToParent(ctx, { ok: true, output: rawOutput })
  if (config.onRunComplete) {
    await notifyHost(step, 'on-complete', async () =>
      await config.onRunComplete!(
        { ...p.runContext, env },
        { output: await answerFor(), outputNodeId },
      ),
    )
  }
  return { output: rawOutput, outputNodeId }
}

/**
 * Close out a run whose every arm has finished. A no-op-ish second write that
 * only matters when {@link deliverOutput} left the run `done` because there was
 * still work to drain.
 *
 * `drainError` is an arm that broke AFTER the answer went out. It never fails
 * the run — the host already has a correct answer — so it lands on the run row
 * as a note beside the failed node's own step, and the result the caller gets
 * back is the one it was already promised.
 */
export async function settleRun<TDeps, E extends GraphWorkflowEnv>(
  ctx: RunCtx<TDeps, E>,
  result: GraphWorkflowResult,
  drainError?: string,
): Promise<GraphWorkflowResult> {
  const { step, env, p } = ctx
  await stepDo(step, 'settle', async () => {
    await completeRun(createWfDb(env.WF_DB), {
      runId: p.workflowRunId,
      error: drainError,
    })
    // Emitted from INSIDE the last step, never from the orchestrator body — the
    // body re-executes on every wake, so an emission there would fire once per
    // hibernation. `settle` is genuinely last on the success path (finalize,
    // report-to-parent and on-complete all precede it), so the step tally read
    // here is the run's final count.
    emitRunPoint(ctx, {
      status: 'completed',
      outputNodeId: result.outputNodeId,
      error: drainError,
      extraSteps: 0,
    })
  })
  if (drainError) {
    console.warn(
      `[wf] run ${p.workflowRunId} delivered its output, but a background branch failed:`,
      drainError,
    )
  }
  return result
}
