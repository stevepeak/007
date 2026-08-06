import { endEntryOf, nodeLabel, startEntryOf } from '../engine/run-log-entries'
import type { RecordStepArgs } from '../engine/run-recorder'
import type { ExecutableNode } from '../engine/scheduler'
import type { RunLogEntry } from '../engine/stream-sink'
import { createWfDb } from '../storage/client'
import { replaceNodeLogs, type WfRunLogRow } from '../storage/data'

import type { GraphWorkflowEnv } from './graph-workflow'
import type { RunCtx } from './graph-workflow-dispatch-run-ctx'
import { stepDo } from './graph-workflow-dispatch-step'
import { DEFAULT_STEP_OPTS } from './graph-workflow-dispatch-step-opts'

// The bookend builders moved to `engine/run-log-entries` once the inline
// backend needed them too. Re-exported here so this module stays the one import
// site for the durable backend's dispatch.
export { nodeLabel, startEntryOf }

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
export async function recordTerminal<TDeps, E extends GraphWorkflowEnv>(
  ctx: RunCtx<TDeps, E>,
  node: ExecutableNode,
  seq: number,
  input: unknown,
  startEntry: RunLogEntry,
  outcome:
    | {
        status: 'failed'
        error: string
        feed?: string
        /** Entries the node emitted before it threw — persisted so a failed
         * node still shows the work it did get through. */
        bodyLogs?: RunLogEntry[]
      }
    | {
        status: 'completed'
        output: unknown
        meta: unknown
        branchResult: RecordStepArgs['branchResult']
        bodyLogs: RunLogEntry[]
        // Actual execution window measured around runNode. Overwrites the
        // enter-time start so the persisted Speed reflects real work, not the
        // dispatch envelope. Absent (e.g. iteration container) → start is left
        // as stamped at enter and finish defaults to record time.
        startedAt?: Date
        finishedAt?: Date
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
        outcome.bodyLogs ?? [],
        endEntryOf(node, seq, Date.now(), true, outcome.feed ?? outcome.error),
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
        startedAt: outcome.startedAt,
        finishedAt: outcome.finishedAt,
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
