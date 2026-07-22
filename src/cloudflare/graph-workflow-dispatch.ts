import type {
  WorkflowStep,
  WorkflowStepConfig,
} from 'cloudflare:workers'

import type { WfSdkConfig } from '../engine/config'
import {
  isDecisionKind,
  type IterationNode,
  type NodeExecution,
  type WfRunManifestEntry,
} from '../engine/graph'
import {
  executeSubgraph,
  resolveIterationList,
  runIteration,
} from '../engine/nodes/iteration'
import { errorMessage, runNode, type NodeRunResult } from '../engine/run-node'
import {
  recordedBranchResult,
  type RecordStepArgs,
} from '../engine/run-recorder'
import type {
  ExecutableNode,
  ReportResult,
  Scheduler,
} from '../engine/scheduler'
import type { RunLogEntry, StreamSink } from '../engine/stream-sink'
import { createWfDb } from '../storage/client'
import { finalizeRun, replaceNodeLogs, type WfRunLogRow } from '../storage/data'
import { createDurableRunRecorder } from '../storage/run-recorder'

import type {
  GraphWorkflowEnv,
  GraphWorkflowParams,
  GraphWorkflowResult,
} from './graph-workflow'
import type { RunRoom } from './run-room'
import { withNodeSpan } from './tracing'

// Per-kind step.do retry/timeout policy defaults. LLM nodes get longer, retried
// steps. A node's optional `execution` policy overrides these field-by-field.
export const AI_STEP_OPTS = {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
  timeout: '3 minutes',
} as const
export const DEFAULT_STEP_OPTS = {
  retries: { limit: 2, delay: '3 seconds', backoff: 'exponential' },
  timeout: '1 minute',
} as const

// Return type is intentionally inferred (not widened to `WorkflowStepConfig`)
// so the const defaults keep their guaranteed `retries`, which `stepOptsFor`
// reads when layering a partial override.
function kindDefaultOpts(kind: string) {
  // The deterministic `branch` needs no retries/long timeout and falls through
  // to the default policy. A `workflow` node runs a whole callee subgraph
  // inline (often several LLM nodes) in one step, so it gets the longer,
  // retried AI policy — authors can raise the timeout further per-node via
  // `execution` for long callees.
  return kind === 'agent' || kind === 'workflow'
    ? AI_STEP_OPTS
    : DEFAULT_STEP_OPTS
}

// Map a node's provider-agnostic `execution` policy onto Cloudflare's
// `WorkflowStepConfig`, layered over the per-kind default so an author can
// override just a timeout or just the retry limit and inherit the rest. The
// engine schema speaks milliseconds; `step.do` accepts a number-of-ms for both
// `timeout` and retry `delay`, so we pass them straight through.
function stepOptsFor(node: {
  kind: string
  execution?: NodeExecution
}): WorkflowStepConfig {
  const base = kindDefaultOpts(node.kind)
  const ex = node.execution
  if (!ex || (ex.timeoutMs == null && ex.retries == null)) {
    return base
  }
  return {
    timeout: ex.timeoutMs ?? base.timeout,
    retries: ex.retries
      ? {
          limit: ex.retries.limit,
          delay: ex.retries.delayMs ?? base.retries.delay,
          backoff: ex.retries.backoff ?? base.retries.backoff,
        }
      : base.retries,
  }
}

// Best-effort host lifecycle notification. Runs in its own durable step (so it
// retries), but a callback that ultimately throws is swallowed (logged) rather
// than changing the run outcome — the run's success/failure is already settled
// by the time we notify. Keeps a broken host callback from turning a completed
// run into a failed one, or masking the real error on the failure path.
export async function notifyHost(
  step: WorkflowStep,
  name: string,
  fn: () => void | Promise<void>,
): Promise<void> {
  try {
    await stepDo(step, name, async () => {
      await fn()
      return null
    })
  } catch (err) {
    console.error(`[wf] lifecycle callback '${name}' failed:`, errorMessage(err))
  }
}

// Cloudflare's `step.do` constrains return values to `Serializable<T>`, which
// rejects the `unknown`-typed JSON our engine produces (the values are JSON;
// the *type* is just wider than Serializable allows). This wrapper localizes
// the single cast at that boundary so call sites and the engine stay clean.
type StepBody<T> = () => Promise<T>
export function stepDo<T>(
  step: WorkflowStep,
  name: string,
  optsOrBody: WorkflowStepConfig | StepBody<T>,
  maybeBody?: StepBody<T>,
): Promise<T> {
  if (typeof optsOrBody === 'function') {
    return step.do(name, optsOrBody as never) as Promise<T>
  }
  return step.do(name, optsOrBody, maybeBody as never) as Promise<T>
}

// Shared run-level locals every hoisted dispatch/log helper closes over. Bundled
// once in `run()` and threaded through so these functions can live at module
// scope instead of nested inside the ~500-line `run()` method.
export type RunCtx<TDeps, E extends GraphWorkflowEnv> = {
  step: WorkflowStep
  env: E
  config: WfSdkConfig<TDeps>
  p: GraphWorkflowParams
  manifest: WfRunManifestEntry[]
  sink: StreamSink
  recordOne: (args: RecordStepArgs) => Promise<void>
  room: DurableObjectStub<RunRoom>
  scheduler: Scheduler
  traceId: string | undefined
}

// Human label for a node in the log feed ("Structure the document",
// "Embed section"), falling back to the kind when a node has no label.
function nodeLabel(node: ExecutableNode): string {
  return (node as { label?: string }).label?.trim() || node.kind
}

// Build the two bookend entries for a node's feed. `node-start` is
// broadcast live from the `enter:` step and persisted (with the body's
// entries) in the `record:` step; `node-end` closes it out.
function startEntryOf(
  node: ExecutableNode,
  seq: number,
  ts: number,
): RunLogEntry {
  return {
    ts,
    level: 'node-start',
    nodeId: node.id,
    nodeKind: node.kind,
    sequence: seq,
    message: `▶ ${nodeLabel(node)}`,
  }
}
function endEntryOf(
  node: ExecutableNode,
  seq: number,
  ts: number,
  failed: boolean,
  detail?: string,
): RunLogEntry {
  return {
    ts,
    level: failed ? 'error' : 'node-end',
    nodeId: node.id,
    nodeKind: node.kind,
    sequence: seq,
    message: failed
      ? `✕ ${nodeLabel(node)} failed${detail ? `: ${detail}` : ''}`
      : `✓ ${nodeLabel(node)}`,
  }
}

// The run: step returns the engine's NodeRunResult plus the structured
// log entries the node emitted during its own step (captured by a per-node
// sink), so they survive `step.do` replay via the workflow journal.
type RunStepResult = NodeRunResult & { logs?: RunLogEntry[] }

// Persist a node's full feed (bookends + body) in one idempotent write,
// and stream its closing line live. Shared by the success + failure
// paths so every node — even a failed one — leaves a readable feed.
async function persistLogs<TDeps, E extends GraphWorkflowEnv>(
  ctx: RunCtx<TDeps, E>,
  node: ExecutableNode,
  seq: number,
  startEntry: RunLogEntry,
  bodyLogs: RunLogEntry[],
  endEntry: RunLogEntry,
): Promise<void> {
  const entries: WfRunLogRow[] = [startEntry, ...bodyLogs, endEntry].map(
    (e) => ({
      nodeId: e.nodeId ?? node.id,
      nodeKind: e.nodeKind ?? node.kind,
      sequence: e.sequence ?? seq,
      level: e.level,
      message: e.message,
      meta: e.meta ?? null,
      ts: e.ts ?? Date.now(),
    }),
  )
  await replaceNodeLogs(createWfDb(ctx.env.DB), {
    runId: ctx.p.workflowRunId,
    nodeId: node.id,
    entries,
  })
  await ctx.room.appendLog(endEntry)
}

// Flip a node's (run_id, node_id) row to its terminal status and rewrite its
// full feed, in one idempotent `record:` step. Factored out of the success and
// failure arms so both open the SAME step key and persist through the same
// path; only the recorded status/payload and the closing feed line differ.
async function recordTerminal<TDeps, E extends GraphWorkflowEnv>(
  ctx: RunCtx<TDeps, E>,
  node: ExecutableNode,
  seq: number,
  input: unknown,
  startEntry: RunLogEntry,
  outcome:
    | { status: 'failed'; error: string }
    | {
        status: 'completed'
        output: unknown
        meta: unknown
        branchResult: RecordStepArgs['branchResult']
        bodyLogs: RunLogEntry[]
      },
): Promise<void> {
  await stepDo(ctx.step, `record:${node.id}`, DEFAULT_STEP_OPTS, async () => {
    if (outcome.status === 'failed') {
      await ctx.recordOne({
        nodeId: node.id,
        nodeKind: node.kind,
        sequence: seq,
        input,
        status: 'failed',
        error: outcome.error,
      })
      await persistLogs(
        ctx,
        node,
        seq,
        startEntry,
        [],
        endEntryOf(node, seq, Date.now(), true, outcome.error),
      )
    } else {
      await ctx.recordOne({
        nodeId: node.id,
        nodeKind: node.kind,
        sequence: seq,
        input,
        status: 'completed',
        output: outcome.output,
        meta: outcome.meta,
        branchResult: outcome.branchResult,
      })
      await persistLogs(
        ctx,
        node,
        seq,
        startEntry,
        outcome.bodyLogs,
        endEntryOf(node, seq, Date.now(), false),
      )
    }
    return null
  })
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
): Promise<RunStepResult> {
  const { step, env, config, p, manifest, sink, scheduler } = ctx
  const iter = await runIteration({
    node,
    // List is a ref into an upstream output, resolved against the
    // scheduler's global outputs — not the forwarded input.
    list: resolveIterationList(node, scheduler.getOutputs()),
    runItem: (item, index) =>
      stepDo(step, `iter:${node.id}:${index}`, AI_STEP_OPTS, async () => {
        const rc = { ...p.runContext, env }
        const toolDeps = await config.buildRunDeps(rc)
        return await executeSubgraph(
          node.config.subgraph,
          item,
          {
            getModel: (modelId) => config.getModel(modelId, rc),
            toolRegistry: config.toolRegistry,
            toolDeps,
            // Overridden per item inside executeSubgraph.
            nodeOutputs: new Map(),
            promptVariables: p.runContext.promptVariables,
            manifest,
            sink,
            resolveBlobRef: config.resolveBlobRef,
            resolveImageRef: config.resolveImageRef,
            simulate: p.runContext.simulate,
            fixtures: p.runContext.fixtures,
            agentOverride: p.runContext.agentOverride,
          },
          // Record each inner node once per item. The recorder is
          // built inside this `iter:` step.do closure (a D1 binding
          // can't cross a step boundary); the whole closure replays
          // on retry, and the `(run_id, node_id, item_index)` upsert
          // makes that replay idempotent.
          {
            recorder: createDurableRunRecorder({
              db: createWfDb(env.DB),
              runId: p.workflowRunId,
            }),
            parentNodeId: node.id,
            itemIndex: index,
          },
        )
      }),
  })
  return {
    schedulerOutput: iter.results,
    recordedOutput: iter.results,
    meta: iter.meta,
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
  const { step, env, config, p, manifest, sink, scheduler, room, traceId } = ctx
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
  await stepDo(step, `enter:${node.id}`, DEFAULT_STEP_OPTS, async () => {
    await ctx.recordOne({
      nodeId: node.id,
      nodeKind: node.kind,
      sequence: seq,
      input,
      status: 'running',
      startedAt: new Date(startTs),
    })
    await replaceNodeLogs(createWfDb(env.DB), {
      runId: p.workflowRunId,
      nodeId: node.id,
      entries: [startRow],
    })
    await room.appendLog(startEntry)
    return null
  })

  let result: RunStepResult
  try {
    if (node.kind === 'iteration') {
      result = await dispatchIteration(ctx, node)
    } else {
      result = await stepDo(
        step,
        `run:${node.id}`,
        stepOptsFor(node),
        async () => {
          const rc = { ...p.runContext, env }
          const toolDeps = await config.buildRunDeps(rc)
          // Per-node sink: every structured entry a node handler emits
          // (agent reasoning, tool calls, our own info lines) is captured
          // for durable persistence AND forwarded to the live sink. Built
          // inside the step so its pushes are journaled with the return
          // value and never re-broadcast on a `step.do` replay.
          const bodyLogs: RunLogEntry[] = []
          const nodeSink: StreamSink = {
            append: (channel, text) => sink.append(channel, text),
            log: (entry) => {
              const e: RunLogEntry = {
                ...entry,
                ts: entry.ts ?? Date.now(),
                nodeId: entry.nodeId ?? node.id,
                nodeKind: entry.nodeKind ?? node.kind,
                sequence: entry.sequence ?? seq,
              }
              bodyLogs.push(e)
              return sink.log?.(e)
            },
          }
          const r = await withNodeSpan(
            {
              traceId,
              runId: p.workflowRunId,
              nodeId: node.id,
              nodeKind: node.kind,
              sequence: seq,
            },
            () =>
              runNode(
                { type: 'execute', node, input },
                {
                  getModel: (modelId) => config.getModel(modelId, rc),
                  toolRegistry: config.toolRegistry,
                  toolDeps,
                  nodeOutputs: scheduler.getOutputs(),
                  promptVariables: p.runContext.promptVariables,
                  manifest,
                  sink: nodeSink,
                  resolveBlobRef: config.resolveBlobRef,
                  resolveImageRef: config.resolveImageRef,
                  simulate: p.runContext.simulate,
                  fixtures: p.runContext.fixtures,
                  agentOverride: p.runContext.agentOverride,
                },
              ),
          )
          return { ...r, logs: bodyLogs }
        },
      )
    }
  } catch (err) {
    const message = errorMessage(err)
    await recordTerminal(ctx, node, seq, input, startEntry, {
      status: 'failed',
      error: message,
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
    bodyLogs: result.logs ?? [],
  })

  return {
    nodeId: node.id,
    report: {
      output: result.schedulerOutput,
      branchResult: result.branchResult,
    },
  }
}

// Settle a completed run: persist the final output, mirror it to the
// RunRoom, and best-effort notify the host. Shared by the two success
// exits — a reached Output (with its node id) and a decision that fizzled
// out (output `undefined`, no node id).
export async function finishRun<TDeps, E extends GraphWorkflowEnv>(
  ctx: RunCtx<TDeps, E>,
  output: unknown,
  outputNodeId: string | null,
): Promise<GraphWorkflowResult> {
  const { step, env, config, p, room } = ctx
  await stepDo(step, 'finalize', () =>
    finalizeRun(createWfDb(env.DB), { runId: p.workflowRunId, output }),
  )
  await stepDo(step, 'room-output', () => room.setOutput(output))
  if (config.onRunComplete) {
    await notifyHost(step, 'on-complete', () =>
      config.onRunComplete!({ ...p.runContext, env }, { output, outputNodeId }),
    )
  }
  return { output, outputNodeId }
}
