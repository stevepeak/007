import { endEntryOf, nodeLabel, startEntryOf } from '../engine/run-log-entries'
import type { RecordStepArgs } from '../engine/run-recorder'
import type { ExecutableNode } from '../engine/scheduler'
import type { RunLogEntry } from '../engine/stream-sink'
import { createWfDb } from '../storage/client'
import {
  replaceNodeLogs,
  upsertNodeLogs,
  type WfRunLogRow,
} from '../storage/data'

import type { GraphWorkflowEnv } from './graph-workflow'
import type { RunCtx } from './graph-workflow-dispatch-run-ctx'
import { stepDo } from './graph-workflow-dispatch-step'
import { DEFAULT_STEP_OPTS } from './graph-workflow-dispatch-step-opts'

// The bookend builders moved to `engine/run-log-entries` once the inline
// backend needed them too. Re-exported here so this module stays the one import
// site for the durable backend's dispatch.
export { nodeLabel, startEntryOf }

/**
 * Does this node drive durable steps of its OWN, instead of running inside a
 * single `run:` step?
 *
 * Two do — an iteration (one `step.do` per item) and a workflow call set to
 * durable execution (spawn + `waitForEvent`) — because `step.do` calls cannot
 * nest. That makes them the only nodes whose feed is emitted from the
 * orchestrator body, which re-executes on every replay of the instance rather
 * than being journaled. Everywhere a node's logs are written, that difference
 * decides HOW: position-keyed upserts for these, delete-then-insert for the
 * rest. Exported so the dispatch and the record step can't answer it
 * differently.
 */
export function ownsItsDurableSteps(node: ExecutableNode): boolean {
  return (
    node.kind === 'iteration' ||
    (node.kind === 'workflow' && node.config.calleeExecution === 'durable')
  )
}

// Persist a node's full feed (bookends + body) in one idempotent write. Shared
// by the success + failure paths so every node — even a failed one — leaves a
// readable feed.
async function persistLogs<TDeps, E extends GraphWorkflowEnv>(
  ctx: RunCtx<TDeps, E>,
  node: ExecutableNode,
  seq: number,
  startEntry: RunLogEntry,
  bodyLogs: RunLogEntry[],
  endEntry: RunLogEntry,
): Promise<void> {
  const row = (e: RunLogEntry): WfRunLogRow => ({
    nodeId: e.nodeId ?? node.id,
    nodeKind: e.nodeKind ?? node.kind,
    sequence: e.sequence ?? seq,
    level: e.level,
    message: e.message,
    meta: e.meta ?? null,
    ts: e.ts ?? Date.now(),
  })
  const db = createWfDb(ctx.env.WF_DB)
  if (ownsItsDurableSteps(node)) {
    // Same rows, written to the SAME slots the live path already used, so this
    // settles the feed in place instead of stacking a second copy of it beside
    // what a replay will emit again. `start`/`end` are named slots because the
    // body's length isn't fixed; the body keeps its emit ordinal.
    await upsertNodeLogs(db, {
      runId: ctx.p.workflowRunId,
      nodeId: node.id,
      rows: [
        { ordinal: 'start', entry: row(startEntry) },
        ...bodyLogs.map((e, i) => ({ ordinal: i, entry: row(e) })),
        { ordinal: 'end', entry: row(endEntry) },
      ],
    })
    return
  }
  await replaceNodeLogs(db, {
    runId: ctx.p.workflowRunId,
    nodeId: node.id,
    entries: [startEntry, ...bodyLogs, endEntry].map(row),
  })
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
