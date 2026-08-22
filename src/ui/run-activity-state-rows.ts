import { RUN_STATE_LEVEL } from '../engine/stream-sink'
import type { WfRunLogDTO } from '../server/protocol'

import type { ActivityNodeRow, ActivityStateRow, ActivityTopRow } from './run-activity-model'

// The run's LIFECYCLE MARKERS — queued / running / done / completed / failed /
// cancelled — and where each one sits among the node rows.
//
// Most markers have a DEFINED position, not a computed one. `queued` and
// `running` precede all node work by definition, and the terminal three follow
// all of it, so they are pinned rather than placed by timestamp.
//
// Pinning is also the only reliable option: `wf_run_step.started_at` is a
// `mode: 'timestamp'` column and therefore truncated to whole SECONDS, while a
// marker's `ts` is exact millis. Comparing the two inside a single second is a
// coin flip — which is precisely where `queued` and `running` land, so they
// were sorting after the first nodes.
//
// `done` is the one marker that genuinely falls among the rows: the whole point
// is seeing which nodes were still running when the answer went out.

/** The run status a lifecycle marker carries, from its `{ status }` meta. */
function readStateStatus(meta: unknown): string | null {
  const status = (meta as { status?: unknown } | null)?.status
  return typeof status === 'string' ? status : null
}

/**
 * How many nodes were still running when the marker was written. Absent on
 * every marker but `done`, and on rows written before the field existed.
 */
function readPendingNodes(meta: unknown): number | null {
  const n = (meta as { pendingNodes?: unknown } | null)?.pendingNodes
  return typeof n === 'number' ? n : null
}

export type StateRowPlacement = {
  /** Pinned before every node row. */
  leading: ActivityStateRow[]
  /** Pinned after every node row. */
  trailing: ActivityStateRow[]
  /** Placed among the node rows by timestamp — in practice, `done`. */
  floating: ActivityStateRow[]
}

export function buildStateRows(logs: WfRunLogDTO[]): StateRowPlacement {
  const stateLogs = logs
    .filter((l) => l.level === RUN_STATE_LEVEL)
    .sort((a, b) => a.ts - b.ts)
  // The run's t0, for the elapsed each later marker reports.
  const runStartTs =
    stateLogs.find((l) => readStateStatus(l.meta) === 'running')?.ts ?? null

  const rows: ActivityStateRow[] = stateLogs.map((l) => {
    const status = readStateStatus(l.meta) ?? 'running'
    return {
      kind: 'state' as const,
      key: `state:${status}`,
      status,
      message: l.message,
      ts: l.ts,
      elapsedMs:
        runStartTs != null && status !== 'queued' && l.ts >= runStartTs
          ? l.ts - runStartTs
          : null,
      pendingNodes: readPendingNodes(l.meta),
    }
  })

  const pinnedRank = (status: string): number =>
    status === 'queued' ? 0 : status === 'running' ? 1 : 2
  const leading = rows
    .filter((r) => r.status === 'queued' || r.status === 'running')
    .sort((a, b) => pinnedRank(a.status) - pinnedRank(b.status))
  const trailing = rows.filter(
    (r) =>
      r.status === 'completed' ||
      r.status === 'failed' ||
      r.status === 'cancelled',
  )
  const floating = rows.filter(
    (r) => !leading.includes(r) && !trailing.includes(r),
  )
  return { leading, trailing, floating }
}

/**
 * Place the floating markers WITHOUT reordering the nodes: walk the ordered
 * nodes and flush every marker at or before each one's start. Node ordering
 * stays sequence-driven.
 *
 * Both sides compare at SECOND granularity, since that is all `started_at`
 * carries — comparing exact millis against a truncated second would place a
 * marker on the wrong side of a node it was actually simultaneous with.
 */
export function interleaveStateRows(
  nodes: Array<{ row: ActivityNodeRow; startTs: number }>,
  { leading, trailing, floating }: StateRowPlacement,
): ActivityTopRow[] {
  const toSeconds = (ms: number): number =>
    Number.isFinite(ms) ? Math.floor(ms / 1000) : ms

  const out: ActivityTopRow[] = [...leading]
  let s = 0
  for (const n of nodes) {
    while (
      s < floating.length &&
      toSeconds(floating[s].ts) <= toSeconds(n.startTs)
    ) {
      out.push(floating[s++])
    }
    out.push(n.row)
  }
  while (s < floating.length) out.push(floating[s++])
  out.push(...trailing)
  return out
}
