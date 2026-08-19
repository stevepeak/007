import { and, asc, count, desc, eq, ne } from 'drizzle-orm'

import { RUN_STATE_LEVEL } from '../../engine/stream-sink'
import type { WfDb } from '../client'
import { wfRun, wfRunLog, type WfRunStatus } from '../schema'

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

// ---------------------------------------------------------------------------
// Live (mid-node) appends
// ---------------------------------------------------------------------------
//
// `replaceNodeLogs` above can only write a node's feed as a whole, at the end —
// which is why a long agent node used to look completely dead to a polling
// client for its entire duration. The two helpers below let the engine persist
// each entry AS IT IS EMITTED, so the feed advances in step with the work.
//
// Replay safety: a `step.do` retry replays its whole closure, so the same
// entries are emitted again. Live rows therefore carry a DETERMINISTIC id —
// `<runId>:<nodeId>:<ordinal>`, where `ordinal` is the node's own emit counter,
// reset at the top of every attempt — and are written as an upsert. Re-emitting
// entry #3 rewrites row #3 instead of appending a duplicate. The terminal
// `replaceNodeLogs` still deletes and rewrites the node's whole feed, so the
// settled row set is authoritative regardless of what the live path did.

/** Deterministic id for a live-appended entry — see the note above. */
function liveLogId(runId: string, nodeId: string, ordinal: number): string {
  return `${runId}:${nodeId}:${ordinal}`
}

/**
 * Persist ONE log entry the instant a node emits it. Best-effort by contract:
 * callers should swallow failures, since a dropped progress line must never
 * fail the node that was merely describing itself.
 */
export async function appendRunLog(
  db: WfDb,
  input: {
    runId: string
    nodeId: string
    /** The node's emit counter for this attempt (0-based). */
    ordinal: number
    entry: WfRunLogRow
  },
): Promise<void> {
  const { runId, nodeId, ordinal, entry } = input
  const row = {
    id: liveLogId(runId, nodeId, ordinal),
    runId,
    nodeId: entry.nodeId ?? nodeId,
    nodeKind: entry.nodeKind ?? null,
    sequence: entry.sequence ?? null,
    level: entry.level,
    message: entry.message,
    meta: entry.meta ?? null,
    ts: entry.ts,
  }
  await db
    .insert(wfRunLog)
    .values(row)
    .onConflictDoUpdate({
      target: wfRunLog.id,
      set: {
        nodeKind: row.nodeKind,
        sequence: row.sequence,
        level: row.level,
        message: row.message,
        meta: row.meta,
        ts: row.ts,
      },
    })
}

/**
 * How many body rows a node has already live-appended, excluding the
 * `node-start` bookend the `enter:` step wrote.
 *
 * Serves two purposes at the top of each `run:` attempt, and it is deliberately
 * NOT a "clear": an earlier attempt's lines are the record of what the node was
 * doing when it died, which is exactly what you need when a step times out and
 * silently starts over.
 *   1. It is the ordinal base for this attempt, so the attempt's rows occupy a
 *      fresh id range and can't overwrite the previous attempt's.
 *   2. Non-zero means "a previous attempt already ran" — the signal the
 *      dispatch uses to mark a visible restart boundary in the feed.
 */
export async function countNodeBodyLogs(
  db: WfDb,
  input: { runId: string; nodeId: string },
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(wfRunLog)
    .where(
      and(
        eq(wfRunLog.runId, input.runId),
        eq(wfRunLog.nodeId, input.nodeId),
        ne(wfRunLog.level, 'node-start'),
      ),
    )
  return row?.n ?? 0
}

// ---------------------------------------------------------------------------
// Run lifecycle markers
// ---------------------------------------------------------------------------
//
// The run row records only its CURRENT status, so the moments it changed are
// otherwise unrecoverable — and one of them has no other home at all:
// `finishedAt` is deliberately stamped when the Output is reached, not when the
// last background arm settles (see `markRunDone`). A run that answered in 16s
// and drained for another 75 therefore looks, everywhere in the UI, like a 16s
// run. These rows are where "when did it actually settle" lives.
//
// Written with a status-derived id so they are idempotent: a durable step that
// replays its status write rewrites the same marker instead of appending a
// second one.

/** Deterministic id — one marker per status, per run. */
function stateLogId(runId: string, status: WfRunStatus): string {
  return `${runId}:run:${status}`
}

// Plain-text fallback. The activity feed composes its own label from `meta`
// (it can time the run off the markers themselves and knows how to format a
// duration); this is what every other reader — a log dump, a CLI — sees.
const STATE_MESSAGE: Record<WfRunStatus, string> = {
  queued: 'Workflow queued',
  running: 'Workflow started',
  done: 'Workflow done',
  completed: 'Workflow completed',
  failed: 'Workflow failed',
  cancelled: 'Workflow cancelled',
}

/**
 * Record that a run entered `status`, as a node-less entry in its feed.
 *
 * Never throws. Every caller is a lifecycle write whose whole job is to move
 * the run forward; losing a marker is a cosmetic gap in the activity feed,
 * while letting it break the transition would strand the run.
 */
export async function recordRunStateChange(
  db: WfDb,
  input: {
    runId: string
    status: WfRunStatus
    ts?: number
    /** Appended to the plain-text message — e.g. why a run failed. */
    detail?: string
    /**
     * Nodes still executing behind the answer, on a `done` marker. Kept
     * structured rather than baked into the message so the feed can render it
     * alongside a duration it computes itself.
     */
    pendingNodes?: number
  },
): Promise<void> {
  const ts = input.ts ?? Date.now()
  const message = input.detail
    ? `${STATE_MESSAGE[input.status]} — ${input.detail}`
    : STATE_MESSAGE[input.status]
  const row = {
    id: stateLogId(input.runId, input.status),
    runId: input.runId,
    nodeId: null,
    nodeKind: null,
    sequence: null,
    level: RUN_STATE_LEVEL,
    message,
    meta: {
      status: input.status,
      ...(input.pendingNodes != null ? { pendingNodes: input.pendingNodes } : {}),
    },
    ts,
  }
  try {
    await db
      .insert(wfRunLog)
      .values(row)
      .onConflictDoUpdate({
        target: wfRunLog.id,
        set: { message: row.message, meta: row.meta, ts: row.ts },
      })
  } catch (err) {
    console.warn('[wf] run state marker not recorded:', err)
  }
}

/**
 * How many log entries one run's feed read returns. An agent node mirrors its
 * reasoning and every tool call into this table, so a long run — or any run
 * with a wide iteration — emits thousands of rows, and the run viewer re-reads
 * the whole feed every 1.5s while it's live.
 */
export const RUN_LOG_READ_LIMIT = 500

/**
 * The run's log feed for the run viewer (loaded once, then polled while the run
 * is live), capped at the NEWEST {@link RUN_LOG_READ_LIMIT} entries and handed
 * back in emit order.
 *
 * Newest-N rather than a cursor, deliberately. `replaceNodeLogs` deletes and
 * rewrites a node's whole feed with fresh UUIDs when the node ends, so a client
 * resuming from a `ts` cursor would either re-receive that node's entries or
 * silently miss them — there is no stable per-entry identity to resume from.
 * A plain cap has no such failure mode.
 *
 * Newest wins over oldest because a live run's feed must keep advancing past
 * the cap: keeping the first 500 would freeze the panel on the run's opening
 * moments and never show the work actually in flight. `truncated` tells the
 * caller entries were dropped so the UI can say so rather than imply the feed
 * is complete.
 */
export async function getRunLogs(
  db: WfDb,
  runId: string,
  limit = RUN_LOG_READ_LIMIT,
): Promise<{ rows: WfRunLogRow[]; truncated: boolean }> {
  // One past the cap, so "there was more" is known without a second COUNT.
  const newestFirst = await db
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
    .orderBy(desc(wfRunLog.ts))
    .limit(limit + 1)
  const truncated = newestFirst.length > limit
  const kept = truncated ? newestFirst.slice(0, limit) : newestFirst
  // Read newest-first to pick the tail; hand back oldest-first, which is the
  // order every consumer renders in.
  return { rows: kept.reverse(), truncated }
}

// What a user-facing progress line IS, so a surface can render each kind
// distinctly (a thinking icon vs a tool icon vs a plain step bullet) rather than
// as one undifferentiated list. Derived from the log row's `meta.progress`,
// which the agent stamps when mirroring its internals into the curated feed;
// a line with no such tag is a node's own `informUser` step note.
export type RunProgressVariant = 'step' | 'reasoning' | 'tool'

/** One user-facing progress line. */
export type RunProgressLine = {
  message: string
  variant: RunProgressVariant
  /** The tool's registry id, on `tool` lines only. */
  tool?: string
}

/** A run's persisted user-facing progress, for a poll-based consumer. */
export type RunProgressFeed = {
  status: WfRunStatus
  /** `wf_run.correlation_id` — the owning org, for host-side authorization. */
  correlationId: string | null
  /** Every user-facing `progress` line in emit order. */
  lines: RunProgressLine[]
}

// Read the line's kind off the stored `meta` blob. Defensive: `meta` is
// free-form JSON written by whatever emitted the entry (and older rows predate
// the tag), so anything unrecognized degrades to a plain step.
function progressLine(row: {
  message: string
  meta: unknown
}): RunProgressLine {
  const meta = (row.meta ?? {}) as Record<string, unknown>
  const variant = meta.progress
  if (variant === 'reasoning') {
    return { message: row.message, variant: 'reasoning' }
  }
  if (variant === 'tool') {
    return {
      message: row.message,
      variant: 'tool',
      ...(typeof meta.tool === 'string' ? { tool: meta.tool } : {}),
    }
  }
  return { message: row.message, variant: 'step' }
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
    .select({ message: wfRunLog.message, meta: wfRunLog.meta })
    .from(wfRunLog)
    .where(and(eq(wfRunLog.runId, runId), eq(wfRunLog.level, 'progress')))
    .orderBy(asc(wfRunLog.ts))
  return {
    status: run.status,
    correlationId: run.correlationId,
    lines: rows.map(progressLine),
  }
}
