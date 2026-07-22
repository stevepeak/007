import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  like,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'

import type { WfDb } from '../client'
import { stepCost } from '../cost'
import {
  wfRun,
  wfRunStep,
  wfWorkflow,
  wfWorkflowVersion,
} from '../schema'

import { loadModelPriceMap } from './runs-cost'
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
}

const RUN_PAGE_MAX = 200
const TOOL_INVOCATION_PAGE_MAX = 100

// Data-rich, filtered, paginated run listing. Joins each run to its version and
// owning workflow so callers can display + search by workflow name. Returns the
// page plus the unpaginated total so the UI can render "N of M".
export async function listRuns(db: WfDb, input: ListRunsFilter) {
  const conds: SQL[] = []
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
    conds.push(eq(wfRun.triggerKind, input.triggerKind))
  }
  if (input.status) {
    conds.push(
      eq(
        wfRun.status,
        input.status as (typeof wfRun.status.enumValues)[number],
      ),
    )
  }
  if (input.since) {
    conds.push(gte(wfRun.createdAt, input.since))
  }
  if (input.until) {
    conds.push(lte(wfRun.createdAt, input.until))
  }
  if (input.search) {
    const q = `%${input.search}%`
    const match = or(
      like(wfWorkflow.name, q),
      like(wfRun.triggerKind, q),
      like(wfRun.subjectId, q),
      like(wfRun.correlationId, q),
    )
    if (match) conds.push(match)
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

  // Aggregate token + dollar cost per run across this page's agent steps. Only
  // this page's runs are queried, so the explorer stays a single-page load.
  const rowsWithCost = await attachRunCost(db, rows)

  return {
    rows: rowsWithCost,
    total: Number(totalRow[0]?.count ?? 0),
    limit,
    offset,
  }
}

/**
 * Fold each run's agent-step token usage into a `{ totalTokens, costUsd }` pair.
 * `totalTokens` is null when a run fired no agents; `costUsd` is null when none
 * of its agents' models were priced (partial pricing yields a best-effort sum).
 */
async function attachRunCost<R extends { id: string }>(
  db: WfDb,
  rows: R[],
): Promise<Array<R & { totalTokens: number | null; costUsd: number | null }>> {
  if (rows.length === 0) return []
  const runIds = rows.map((r) => r.id)
  const [priceMap, stepRows] = await Promise.all([
    loadModelPriceMap(db),
    db
      .select({ runId: wfRunStep.runId, meta: wfRunStep.meta })
      .from(wfRunStep)
      .where(inArray(wfRunStep.runId, runIds)),
  ])

  const agg = new Map<
    string,
    { tokens: number; hasTokens: boolean; cost: number; hasCost: boolean }
  >()
  for (const sr of stepRows) {
    const c = stepCost(sr.meta, priceMap)
    if (!c) continue
    const a = agg.get(sr.runId) ?? {
      tokens: 0,
      hasTokens: false,
      cost: 0,
      hasCost: false,
    }
    a.tokens += c.tokens
    a.hasTokens = true
    if (c.cost != null) {
      a.cost += c.cost
      a.hasCost = true
    }
    agg.set(sr.runId, a)
  }

  return rows.map((r) => {
    const a = agg.get(r.id)
    return {
      ...r,
      totalTokens: a?.hasTokens ? a.tokens : null,
      costUsd: a?.hasCost ? a.cost : null,
    }
  })
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
