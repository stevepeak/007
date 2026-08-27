import { and, asc, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm'

import type { WfDb } from '../client'
import { wfRun, wfRunStep, wfWorkflow, wfWorkflowVersion } from '../schema'

import { countChildRuns, topLevelRunCondition } from './runs-children'
import { aggregateRunCost } from './runs-cost'
import { rollUpRunCost } from './runs-rollup'
import { clampLimit } from './shared'

// ---------------------------------------------------------------------------
// Filtered/paginated run listing, per-run cost aggregation, and tool-call feeds
// ---------------------------------------------------------------------------

export type ListRunsFilter = {
  workflowVersionId?: string
  workflowId?: string
  triggerKind?: string
  status?: string
  search?: string
  since?: Date
  until?: Date
  limit?: number
  offset?: number
  /** Include eval-produced runs. Default false — they're hidden from the explorer. */
  includeEval?: boolean
  /**
   * List child runs as rows of their own instead of nesting them under their
   * parent. Default false — the explorer wants one row per tree.
   *
   * The dashboard's failures panel wants the opposite: it renders one row per
   * failure WITH its error text, and under nesting a `stopOnError: false` item
   * failure would surface as its green, error-free parent. Listed flat, the
   * failed item is its own row carrying its own error and linking to the run
   * that recorded it.
   */
  includeChildren?: boolean
}

const RUN_PAGE_MAX = 200
const TOOL_INVOCATION_PAGE_MAX = 100

// Data-rich, filtered, paginated run listing. Joins each run to its version and
// owning workflow so callers can display + search by workflow name. Returns the
// page plus the unpaginated total so the UI can render "N of M".
export async function listRuns(db: WfDb, input: ListRunsFilter) {
  // SCOPE conditions — what set of runs is being looked at at all. These apply
  // to the parent row itself and are never satisfied by a descendant: a filter
  // that says "this workflow, this week" must not start returning last month's
  // runs because one of their children matches.
  const conds: SQL[] = []
  // Only runs that HEAD a tree. A child appears under its parent (fetched by
  // `listChildRuns` when the row is expanded), not as a row of its own — a
  // 12-recipe document would otherwise read as 13 unrelated runs.
  if (!input.includeChildren) {
    conds.push(topLevelRunCondition())
  }
  if (!input.includeEval) {
    conds.push(eq(wfRun.isEval, false))
  }
  if (input.workflowVersionId) {
    conds.push(eq(wfRun.workflowVersionId, input.workflowVersionId))
  }
  if (input.workflowId) {
    conds.push(eq(wfWorkflowVersion.workflowId, input.workflowId))
  }
  if (input.triggerKind) {
    // Not descendant-matched: a child inherits its parent's trigger kind
    // wholesale (see `createRun`'s `parent` call sites), so an EXISTS here
    // could only ever agree with the parent's own value at extra cost.
    conds.push(eq(wfRun.triggerKind, input.triggerKind))
  }
  if (input.since) {
    conds.push(gte(wfRun.createdAt, input.since))
  }
  if (input.until) {
    conds.push(lte(wfRun.createdAt, input.until))
  }

  // MATCH conditions — what is being looked FOR. A tree matches when its head
  // matches or any of its children does, so work that happened inside a child
  // stays findable from the top-level view.
  //
  // The case that makes this load-bearing is `stopOnError: false`: a failed
  // item leaves a placeholder and the parent still COMPLETES, so filtering on
  // `status: failed` would otherwise hide the failure entirely — the parent is
  // green and the child isn't a row of its own. Search matters for the callee
  // case, where a child runs a different workflow and carries a name its parent
  // doesn't.
  //
  // Written as raw SQL over a table ALIAS rather than with drizzle column
  // helpers, so the very same predicate can be applied to the parent row and to
  // the correlated child subquery. Two hand-kept copies would be the obvious
  // way to write this and the obvious way for the two halves to drift, which on
  // a filter means quietly returning the wrong set.
  const matchPredicate = (run: string, workflow: string): SQL | null => {
    const parts: SQL[] = []
    if (input.status) {
      parts.push(sql`${sql.raw(run)}.status = ${input.status}`)
    }
    if (input.search) {
      const q = `%${input.search}%`
      // The note is the only free text a human writes about a run, so it is
      // the term most likely to be searched for — "the timeout one".
      parts.push(sql`(
        ${sql.raw(workflow)}.name like ${q}
        or ${sql.raw(run)}.trigger_kind like ${q}
        or ${sql.raw(run)}.subject_id like ${q}
        or ${sql.raw(run)}.correlation_id like ${q}
        or ${sql.raw(run)}.note like ${q}
      )`)
    }
    return parts.length > 0 ? sql.join(parts, sql` and `) : null
  }

  const ownMatch = matchPredicate('wf_run', 'wf_workflow')
  if (ownMatch && input.includeChildren) {
    // Children are rows in their own right here, so there is nothing to bubble
    // up — and bubbling would double-report every failure (once on the child,
    // once on its parent).
    conds.push(ownMatch)
  } else if (ownMatch) {
    // One correlated EXISTS over `wf_run_parent_idx`, joined out to the child's
    // own workflow name. It rides on a WHERE that already scans (the `like`s
    // are leading-wildcard, and status alone is unindexed), so this is a
    // constant multiplier on that scan rather than a new class of cost — but it
    // IS a per-row subquery, and is the first thing to look at if the explorer
    // ever slows down. Only one level deep: a grandchild's failure surfaces on
    // its own parent, which surfaces here.
    const childMatch = matchPredicate('child_run', 'child_workflow')
    conds.push(sql`(${ownMatch} or exists (
      select 1 from wf_run as child_run
      join wf_workflow_version as child_version
        on child_version.id = child_run.workflow_version_id
      join wf_workflow as child_workflow
        on child_workflow.id = child_version.workflow_id
      where child_run.parent_run_id = wf_run.id and ${childMatch}
    ))`)
  }

  const where = and(...conds)
  const limit = clampLimit(input.limit, { fallback: 50, max: RUN_PAGE_MAX })
  const offset = Math.max(input.offset ?? 0, 0)

  const rows = await db
    .select({
      id: wfRun.id,
      status: wfRun.status,
      triggerKind: wfRun.triggerKind,
      subjectId: wfRun.subjectId,
      correlationId: wfRun.correlationId,
      createdAt: wfRun.createdAt,
      startedAt: wfRun.startedAt,
      finishedAt: wfRun.finishedAt,
      error: wfRun.error,
      note: wfRun.note,
      workflowId: wfWorkflowVersion.workflowId,
      workflowName: wfWorkflow.name,
      versionNumber: wfWorkflowVersion.versionNumber,
    })
    .from(wfRun)
    .innerJoin(
      wfWorkflowVersion,
      eq(wfRun.workflowVersionId, wfWorkflowVersion.id),
    )
    .innerJoin(wfWorkflow, eq(wfWorkflowVersion.workflowId, wfWorkflow.id))
    .where(where)
    .orderBy(desc(wfRun.createdAt))
    .limit(limit)
    .offset(offset)

  const totalRow = await db
    .select({ count: sql<number>`count(*)` })
    .from(wfRun)
    .innerJoin(
      wfWorkflowVersion,
      eq(wfRun.workflowVersionId, wfWorkflowVersion.id),
    )
    .innerJoin(wfWorkflow, eq(wfWorkflowVersion.workflowId, wfWorkflow.id))
    .where(where)

  // Both keyed on this page's run ids only, so the explorer stays a single-page
  // load: token + dollar cost across each run's own agent steps, and how many
  // children each one spawned. The child ROWS are fetched on expand.
  const runIds = rows.map((r) => r.id)
  const [costs, childCounts] = await Promise.all([
    aggregateRunCost(db, runIds),
    countChildRuns(db, runIds),
  ])

  // The wider number, for the rows that need one. A run with no children has a
  // tree total identical to its own, so asking for one would be three queries
  // to learn nothing — and on a page with no fan-outs at all this costs zero.
  const trees = await rollUpRunCost(db, [...childCounts.keys()])

  return {
    rows: rows.map((r) => ({
      ...r,
      // This run's OWN cost. Kept alongside the tree total rather than replaced
      // by it: they answer different questions, and a parent that reads $0.02
      // itself while its items spent $4 is worth being able to see.
      totalTokens: costs.get(r.id)?.totalTokens ?? null,
      costUsd: costs.get(r.id)?.costUsd ?? null,
      tree: trees.get(r.id) ?? null,
      children: childCounts.get(r.id) ?? null,
    })),
    total: Number(totalRow[0]?.count ?? 0),
    limit,
    offset,
  }
}

/**
 * Recent invocations of one tool across all runs. A tool call is a
 * `wf_run_step` with `nodeKind = 'tool'` whose recorded `meta.toolId` matches;
 * we join back to the run (for timestamps) and its owning workflow (for a
 * display name). Newest first. Powers the tool detail page's "recent calls"
 * list.
 */
export async function listToolInvocations(
  db: WfDb,
  input: { toolId: string; limit?: number },
) {
  const limit = clampLimit(input.limit, {
    fallback: 20,
    max: TOOL_INVOCATION_PAGE_MAX,
  })
  const rows = await db
    .select({
      runId: wfRunStep.runId,
      nodeId: wfRunStep.nodeId,
      status: wfRunStep.status,
      meta: wfRunStep.meta,
      output: wfRunStep.output,
      error: wfRunStep.error,
      startedAt: wfRunStep.startedAt,
      finishedAt: wfRunStep.finishedAt,
      workflowId: wfWorkflowVersion.workflowId,
      workflowName: wfWorkflow.name,
    })
    .from(wfRunStep)
    .innerJoin(wfRun, eq(wfRunStep.runId, wfRun.id))
    .innerJoin(
      wfWorkflowVersion,
      eq(wfRun.workflowVersionId, wfWorkflowVersion.id),
    )
    .innerJoin(wfWorkflow, eq(wfWorkflowVersion.workflowId, wfWorkflow.id))
    .where(
      and(
        eq(wfRunStep.nodeKind, 'tool'),
        eq(sql`json_extract(${wfRunStep.meta}, '$.toolId')`, input.toolId),
      ),
    )
    .orderBy(desc(wfRunStep.startedAt))
    .limit(limit)
  return rows
}

/** Distinct trigger kinds present in the runs (filter dropdown). */
export async function listRunTriggerKinds(db: WfDb) {
  const rows = await db
    .selectDistinct({ triggerKind: wfRun.triggerKind })
    .from(wfRun)
    .orderBy(asc(wfRun.triggerKind))
  return rows.map((r) => r.triggerKind)
}
