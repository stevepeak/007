import { and, asc, eq } from 'drizzle-orm'

import type { WfDb } from '../client'
import { wfRun, wfRunLog } from '../schema'

// ---------------------------------------------------------------------------
// Run logs — the structured progress feed (wf_run_log)
// ---------------------------------------------------------------------------

// A structured log entry as stored/returned. Mirrors the engine's RunLogEntry
// but with `ts` required (the engine always stamps it before persistence).
export type WfRunLogRow = {
  nodeId: string | null
  nodeKind: string | null
  sequence: number | null
  level: string
  message: string
  meta: unknown
  ts: number
}

// D1 caps bound parameters (~100) per statement; each log row binds 8, so flush
// in batches well under that. Text is left intact (a single reasoning blob is
// well under the ~100 KB statement ceiling).
const MAX_LOG_ROWS_PER_INSERT = 10

// Replace all persisted logs for one node with `entries`, atomically per node.
// Called from the (idempotent, once-per-node) record step, so a retried step
// re-runs delete-then-insert and can never duplicate a node's feed. `entries`
// already carry their node id / kind / sequence / ts (stamped by the per-node
// sink). A node with nothing to say writes nothing (and clears any prior rows).
export async function replaceNodeLogs(
  db: WfDb,
  input: { runId: string; nodeId: string; entries: WfRunLogRow[] },
): Promise<void> {
  await db
    .delete(wfRunLog)
    .where(
      and(eq(wfRunLog.runId, input.runId), eq(wfRunLog.nodeId, input.nodeId)),
    )
  if (input.entries.length === 0) return
  const rows = input.entries.map((e) => ({
    id: crypto.randomUUID(),
    runId: input.runId,
    nodeId: e.nodeId ?? input.nodeId,
    nodeKind: e.nodeKind ?? null,
    sequence: e.sequence ?? null,
    level: e.level,
    message: e.message,
    meta: e.meta ?? null,
    ts: e.ts,
  }))
  for (let i = 0; i < rows.length; i += MAX_LOG_ROWS_PER_INSERT) {
    await db.insert(wfRunLog).values(rows.slice(i, i + MAX_LOG_ROWS_PER_INSERT))
  }
}

// The whole run's log feed in emit order, for the run viewer (loaded once, then
// polled while the run is live).
export async function getRunLogs(
  db: WfDb,
  runId: string,
): Promise<WfRunLogRow[]> {
  const rows = await db
    .select({
      nodeId: wfRunLog.nodeId,
      nodeKind: wfRunLog.nodeKind,
      sequence: wfRunLog.sequence,
      level: wfRunLog.level,
      message: wfRunLog.message,
      meta: wfRunLog.meta,
      ts: wfRunLog.ts,
    })
    .from(wfRunLog)
    .where(eq(wfRunLog.runId, runId))
    .orderBy(asc(wfRunLog.ts))
  return rows
}

/** A run's persisted user-facing progress, for a poll-based consumer. */
export type RunProgressFeed = {
  status: string
  /** `wf_run.correlation_id` — the owning org, for host-side authorization. */
  correlationId: string | null
  /** Every user-facing `progress` line in emit order. */
  lines: string[]
}

// The full USER-FACING progress feed for a run, read from the PERSISTED tables
// (keyed by `wf_run.id` = `workflowRunId`). This is the single source a client
// polls to show "what's happening" — during the run and after, with no live
// RunRoom subscription or token. Null when the run row is absent. `status`
// (from `wf_run`) lets the poller stop; `correlationId` lets the host authorize.
export async function getRunProgressFeed(
  db: WfDb,
  runId: string,
): Promise<RunProgressFeed | null> {
  const [run] = await db
    .select({ status: wfRun.status, correlationId: wfRun.correlationId })
    .from(wfRun)
    .where(eq(wfRun.id, runId))
    .limit(1)
  if (!run) return null
  const rows = await db
    .select({ message: wfRunLog.message })
    .from(wfRunLog)
    .where(and(eq(wfRunLog.runId, runId), eq(wfRunLog.level, 'progress')))
    .orderBy(asc(wfRunLog.ts))
  return {
    status: run.status,
    correlationId: run.correlationId,
    lines: rows.map((r) => r.message),
  }
}
