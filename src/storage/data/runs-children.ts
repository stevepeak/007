import { asc, eq, inArray, sql } from 'drizzle-orm'

import type { WfDb } from '../client'
import { TOP_LEVEL_ITEM_INDEX, wfRun, wfWorkflow, wfWorkflowVersion } from '../schema'

import { aggregateRunCost } from './runs-cost'
import { selectChunked } from './shared'

// ---------------------------------------------------------------------------
// Nested runs — the children a run spawned, and the counts that describe them
// ---------------------------------------------------------------------------
//
// A run spawns children two ways: a workflow-call node running its callee as a
// child instance (one child, `item_index` = the top-level sentinel), and a
// durable iteration running each item as a child instance (N children, 0-based
// `item_index`). Both write `parent_run_id` / `parent_node_id` at spawn time —
// see `createRun`'s `parent` argument and NEW-172 — so the link exists from the
// moment the child is created, long before it produces a result.
//
// That timing is the whole reason these reads go to `wf_run` rather than to the
// parent's recorded step meta: the parent's iteration step is written when the
// LOOP settles, so a meta-driven item list would stay empty for the entire time
// there is something to watch.

/** Run statuses that can never change again — what "settled" counts here. */
export const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled'] as const

/**
 * How a parent's children are doing, without loading them.
 *
 * `settled` counts children in a terminal state; `failed` is the number that
 * ended badly. `failed` is tracked separately rather than derived at render
 * time because it is the one number that must survive into a COLLAPSED parent
 * row: with `stopOnError: false` a failed item leaves a placeholder and the
 * parent still completes, so a run that looks green at the top level can be
 * hiding a failure — and nobody expands a row that looks fine.
 */
export type ChildRunCounts = {
  total: number
  settled: number
  failed: number
}

/**
 * One child run, in the shape the runs list and the run viewer both render.
 * Joined to its version + workflow so a callee child (which runs a DIFFERENT
 * workflow from its parent) can name itself.
 */
export type ChildRunRow = {
  id: string
  status: string
  triggerKind: string
  workflowId: string
  workflowName: string
  versionNumber: number
  subjectId: string | null
  correlationId: string | null
  createdAt: Date
  startedAt: Date | null
  finishedAt: Date | null
  error: string | null
  note: string | null
  sentryTraceId: string | null
  parentRunId: string | null
  parentNodeId: string | null
  /** 0-based iteration item, or null for a single workflow-call callee. */
  itemIndex: number | null
  totalTokens: number | null
  costUsd: number | null
}

/**
 * Per-parent child counts for a page of runs, in ONE grouped query over the
 * `(parent_run_id, item_index)` index. Parents with no children are absent.
 *
 * This is what lets the runs list stay a single-page load while still saying
 * something true about a fan-out: the counts ride along with the page, and the
 * child ROWS are fetched only for the parent someone actually expands (see
 * {@link listChildRuns}). Fetching a few preview children for every parent
 * instead would pay for rows nobody looks at on every page load, and would
 * still not surface a failure at item 7 — the `failed` count does.
 */
export async function countChildRuns(
  db: WfDb,
  parentRunIds: readonly string[],
): Promise<Map<string, ChildRunCounts>> {
  const out = new Map<string, ChildRunCounts>()
  if (parentRunIds.length === 0) return out
  // Chunked, and the fold is keyed by the chunked column — so `GROUP BY
  // parent_run_id` results can be concatenated without merging (see
  // `selectChunked`'s correctness rule).
  const rows = await selectChunked(parentRunIds, (ids) =>
    db
      .select({
        parentRunId: wfRun.parentRunId,
        total: sql<number>`count(*)`,
        settled: sql<number>`sum(case when ${inArray(wfRun.status, TERMINAL_RUN_STATUSES)} then 1 else 0 end)`,
        failed: sql<number>`sum(case when ${eq(wfRun.status, 'failed')} then 1 else 0 end)`,
      })
      .from(wfRun)
      .where(inArray(wfRun.parentRunId, ids))
      .groupBy(wfRun.parentRunId),
  )
  for (const r of rows) {
    if (!r.parentRunId) continue
    out.set(r.parentRunId, {
      total: Number(r.total ?? 0),
      settled: Number(r.settled ?? 0),
      failed: Number(r.failed ?? 0),
    })
  }
  return out
}

/**
 * Every child of ONE run, ordered by item index, with each child's own cost.
 *
 * Bounded by the spawning node: a workflow-call node has exactly one child, and
 * an iteration's fan-out is already fenced by its `maxItems` (see
 * `iterationItemLimit`), so this is not an unbounded read.
 *
 * Cost is each child's OWN total, never a roll-up of its own descendants — so a
 * child that itself fans out under-reports on this row. Deliberate: nesting is
 * one level in every graph shipped today, and paying for a tree walk per child
 * row to cover a case none of them hit is the wrong trade. Nothing is lost
 * either way, because the PARENT's total (`rollUpRunCost`) walks the whole tree
 * and already includes those grandchildren.
 */
export async function listChildRuns(
  db: WfDb,
  parentRunId: string,
): Promise<ChildRunRow[]> {
  const rows = await db
    .select({
      id: wfRun.id,
      status: wfRun.status,
      triggerKind: wfRun.triggerKind,
      workflowId: wfWorkflowVersion.workflowId,
      workflowName: wfWorkflow.name,
      versionNumber: wfWorkflowVersion.versionNumber,
      subjectId: wfRun.subjectId,
      correlationId: wfRun.correlationId,
      createdAt: wfRun.createdAt,
      startedAt: wfRun.startedAt,
      finishedAt: wfRun.finishedAt,
      error: wfRun.error,
      note: wfRun.note,
      sentryTraceId: wfRun.sentryTraceId,
      parentRunId: wfRun.parentRunId,
      parentNodeId: wfRun.parentNodeId,
      itemIndex: wfRun.itemIndex,
    })
    .from(wfRun)
    .innerJoin(
      wfWorkflowVersion,
      eq(wfRun.workflowVersionId, wfWorkflowVersion.id),
    )
    .innerJoin(wfWorkflow, eq(wfWorkflowVersion.workflowId, wfWorkflow.id))
    .where(eq(wfRun.parentRunId, parentRunId))
    // `item_index` is never NULL (the sentinel covers the top-level case), so
    // this needs no NULL handling — and `wf_run_parent_idx` covers it. Created
    // time breaks ties for the callee sentinel, where several workflow-call
    // nodes in one graph all sit at -1.
    .orderBy(asc(wfRun.itemIndex), asc(wfRun.createdAt))

  const costs = await aggregateRunCost(
    db,
    rows.map((r) => r.id),
  )

  return rows.map((r) => {
    const c = costs.get(r.id)
    return {
      ...r,
      // Surface the sentinel as null, so `itemIndex: number | null` reads
      // naturally on the wire — same convention the step DTO uses.
      itemIndex: r.itemIndex === TOP_LEVEL_ITEM_INDEX ? null : r.itemIndex,
      totalTokens: c?.totalTokens ?? null,
      costUsd: c?.costUsd ?? null,
    }
  })
}

/**
 * Is this run's `parent_run_id` dangling — i.e. the parent row is gone?
 *
 * `deleteWorkflow` removes a workflow's runs but not the runs of OTHER
 * workflows those runs spawned, so deleting a caller orphans its durable
 * callees' rows. An orphan must still be listable, or a run vanishes from the
 * explorer entirely; see the top-level predicate in `listRuns`.
 */
function orphanedChildCondition() {
  return sql`not exists (select 1 from wf_run as parent_lookup where parent_lookup.id = ${wfRun.parentRunId})`
}

/**
 * The predicate selecting only runs that head a tree: no parent, or a parent
 * that no longer exists. Shared by the listing and its total-count query so the
 * two can never disagree about what a top-level run is.
 */
export function topLevelRunCondition() {
  return sql`(${wfRun.parentRunId} is null or ${orphanedChildCondition()})`
}

// ---------------------------------------------------------------------------
// The descendant set — every run beneath a root, at any depth
// ---------------------------------------------------------------------------

/**
 * How many levels of nesting a tree walk follows.
 *
 * Real graphs are one level (a document fans out into recipes) or two (an item
 * that itself calls a workflow). The bound exists for the pathological cases
 * rather than the real ones: it caps the round trips a single roll-up can make,
 * and it is a second belt beside the visited-set below if a `parent_run_id`
 * cycle is ever written. A tree deeper than this reports the totals of the part
 * that was walked — under-reporting a number is recoverable, hanging a page
 * load on an unbounded walk is not.
 */
export const MAX_RUN_TREE_DEPTH = 8

/**
 * Each root mapped to itself plus every run beneath it, walked breadth-first.
 *
 * One indexed query per LEVEL rather than one per run: each level asks
 * `parent_run_id IN (…the level above…)` straight down `wf_run_parent_idx`, and
 * the walk stops as soon as a level comes back empty — so the common case of a
 * root with no children at all costs exactly one query, and a one-level fan-out
 * costs two.
 *
 * Drizzle 0.45 has no recursive-CTE builder and this SDK talks to D1 through
 * three different drivers (binding, HTTP proxy, bun:sqlite in tests), so a
 * hand-written `WITH RECURSIVE` would have to be raw SQL whose row shape
 * differs per driver. Levels are portable, and the depth that matters is small.
 *
 * Roots are independent, not a partition: ask for a parent and its own child
 * and the parent still reports the whole subtree while the child reports its
 * own. They are two different questions ("what did this cost?") asked twice,
 * and answering the first by subtracting the second would be wrong. The
 * visited set is therefore per root — which is also what breaks a cycle,
 * should a `parent_run_id` loop ever be written.
 */
export async function descendantRunIds(
  db: WfDb,
  rootIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (rootIds.length === 0) return out
  const seen = new Map<string, Set<string>>()
  for (const id of new Set(rootIds)) {
    out.set(id, [id])
    seen.set(id, new Set([id]))
  }

  let frontier = [...out.keys()].map((id) => ({ root: id, id }))
  for (
    let depth = 0;
    depth < MAX_RUN_TREE_DEPTH && frontier.length > 0;
    depth++
  ) {
    // One query for the whole level, even where two roots are walking through
    // the same run — the fan-out below re-attaches each child to every root
    // that reached it.
    const rows = await selectChunked([...new Set(frontier.map((f) => f.id))], (ids) =>
      db
        .select({ id: wfRun.id, parentRunId: wfRun.parentRunId })
        .from(wfRun)
        .where(inArray(wfRun.parentRunId, ids)),
    )
    const byParent = new Map<string, string[]>()
    for (const r of rows) {
      if (!r.parentRunId) continue
      const arr = byParent.get(r.parentRunId) ?? []
      arr.push(r.id)
      byParent.set(r.parentRunId, arr)
    }

    const next: Array<{ root: string; id: string }> = []
    for (const f of frontier) {
      const visited = seen.get(f.root)
      if (!visited) continue
      for (const childId of byParent.get(f.id) ?? []) {
        if (visited.has(childId)) continue
        visited.add(childId)
        out.get(f.root)?.push(childId)
        next.push({ root: f.root, id: childId })
      }
    }
    frontier = next
  }
  return out
}
