import {
  isDecisionKind,
  type IterationNode,
} from '../engine/graph'
import {
  executeSubgraph,
  resolveIterationList,
  runIteration,
} from '../engine/nodes/iteration'
import { errorMessage, runNode, type NodeRunResult } from '../engine/run-node'
import { recordedBranchResult } from '../engine/run-recorder'
import type { ExecutableNode, ReportResult } from '../engine/scheduler'
import type { RunLogEntry, StreamSink } from '../engine/stream-sink'
import { createWfDb } from '../storage/client'
import { finalizeRun, replaceNodeLogs, type WfRunLogRow } from '../storage/data'
import { createDurableRunRecorder } from '../storage/run-recorder'

import type {
  GraphWorkflowEnv,
  GraphWorkflowResult,
} from './graph-workflow'
import {
  startEntryOf,
  recordTerminal,
} from './graph-workflow-dispatch-logs'
import type { RunCtx } from './graph-workflow-dispatch-run-ctx'
import { notifyHost, stepDo } from './graph-workflow-dispatch-step'
import {
  AI_STEP_OPTS,
  DEFAULT_STEP_OPTS,
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
type RunStepResult = NodeRunResult & { logs?: RunLogEntry[] }

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
