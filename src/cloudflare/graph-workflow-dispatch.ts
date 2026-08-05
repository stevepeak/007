import { NonRetryableError } from 'cloudflare:workflows'

import {
  apiErrorDetail,
  errorFeedLine,
  errorStored,
} from '../engine/error-detail'
import { isDecisionKind, type IterationNode } from '../engine/graph'
import { modelBudgetFor } from '../engine/model-budget'
import { nodeSpanLabel } from '../engine/node-label'
import { isFatalAgentError } from '../engine/nodes/agent-generation'
import { emitNodeStartProgress } from '../engine/node-progress'
import {
  executeSubgraph,
  resolveIterationList,
  runIteration,
} from '../engine/nodes/iteration'
import { runNode, type NodeRunResult } from '../engine/run-node'
import { recordedBranchResult } from '../engine/run-recorder'
import type { ExecutableNode, ReportResult } from '../engine/scheduler'
import type { RunLogEntry, StreamSink } from '../engine/stream-sink'
import { enforceOutputContract } from '../engine/trigger-registry'
import { createWfDb } from '../storage/client'
import {
  appendRunLog,
  countNodeBodyLogs,
  finalizeRun,
  replaceNodeLogs,
  type WfRunLogRow,
} from '../storage/data'
import { createDurableRunRecorder } from '../storage/run-recorder'

import type { GraphWorkflowEnv, GraphWorkflowResult } from './graph-workflow'
import {
  nodeLabel,
  startEntryOf,
  recordTerminal,
} from './graph-workflow-dispatch-logs'
import type { RunCtx } from './graph-workflow-dispatch-run-ctx'
import { notifyHost, stepDo } from './graph-workflow-dispatch-step'
import {
  AI_STEP_OPTS,
  DEFAULT_STEP_OPTS,
  resolveStepTimeoutMs,
  stepOptsFor,
} from './graph-workflow-dispatch-step-opts'
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
): Promise<RunStepResult> {
  const { step, env, config, p, manifest, sink, scheduler } = ctx
  const iter = await runIteration({
    node,
    // List is a ref into an upstream output, resolved against the
    // scheduler's global outputs — not the forwarded input.
    list: resolveIterationList(node, scheduler.getOutputs()),
    sink,
    runItem: (item, index) =>
      stepDo(step, `iter:${node.id}:${index}`, AI_STEP_OPTS, async () => {
        const rc = { ...p.runContext, env }
        const toolDeps = await config.buildRunDeps(rc)
        return await executeSubgraph(
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
            sink,
            resolveBlobRef: config.resolveBlobRef,
            resolveImageRef: config.resolveImageRef,
            simulate: p.runContext.simulate,
            fixtures: p.runContext.fixtures,
            freezeTools: p.runContext.freezeTools,
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
  try {
    if (node.kind === 'iteration') {
      // Iteration runs its own per-item durable steps (no `run:` step to host a
      // per-node sink), so emit its coarse progress line straight to the run
      // sink; per-item lines follow from `runIteration`.
      emitNodeStartProgress(sink, node, p.runContext.promptVariables)
      result = await dispatchIteration(ctx, node)
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
          const logDb = createWfDb(env.DB)
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
          // `wf_run_log` IMMEDIATELY, (b) forwarded to the live RunRoom, and
          // (c) buffered for the terminal rewrite. (a) is what makes a run
          // observable while it runs — every consumer polls the persisted feed,
          // so without it a node is invisible until it finishes.
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
                      resolveImageRef: config.resolveImageRef,
                      simulate: p.runContext.simulate,
                      fixtures: p.runContext.fixtures,
                      freezeTools: p.runContext.freezeTools,
                      agentOverride: p.runContext.agentOverride,
                      // Delegation: an agent node may spawn sub-agents/workflows
                      // inline and record each as a child step. Built inside this
                      // `run:` closure (a D1 binding can't cross a step boundary);
                      // the whole closure replays on retry and the
                      // `(run_id, node_id, item_index)` upsert makes that idempotent.
                      subStepRecorder:
                        node.kind === 'agent'
                          ? createDurableRunRecorder({
                              db: createWfDb(env.DB),
                              runId: p.workflowRunId,
                            })
                          : undefined,
                    },
                  ),
              ),
          )
          return {
            ...r,
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
    bodyLogs: result.logs ?? [],
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

// Settle a completed run: persist the final output, mirror it to the
// RunRoom, and best-effort notify the host. Shared by the two success
// exits — a reached Output (with its node id) and a decision that fizzled
// out (output `undefined`, no node id).
export async function finishRun<TDeps, E extends GraphWorkflowEnv>(
  ctx: RunCtx<TDeps, E>,
  rawOutput: unknown,
  outputNodeId: string | null,
): Promise<GraphWorkflowResult> {
  const { step, env, config, p, room, scheduler } = ctx
  // Enforce the trigger's output contract (e.g. chat's `{ text }`) before we
  // persist anything: a run whose Output was bound to the wrong shape — or that
  // fizzled out with no result under a contract that requires one — fails here
  // (the caller's catch records the failure) rather than the host reading an
  // empty result. Pure, deterministic Zod on an in-hand value, so it's safe in
  // the orchestrator (no step.do needed). Contract-less triggers pass through.
  const output = enforceOutputContract(
    config.triggers,
    scheduler.trigger.config.triggerKind,
    rawOutput,
  )
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
