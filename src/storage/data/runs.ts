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

import type { WfRunManifestEntry } from '../../engine/graph'
import type { WfDb } from '../client'
import { stepCost, type ModelPrice, type ModelPriceMap } from '../cost'
import {
  wfModel,
  wfRun,
  wfRunLog,
  wfRunStep,
  wfWorkflow,
  wfWorkflowVersion,
} from '../schema'

import { latestVersion, parseStoredGraph } from './authoring'
import { clampLimit } from './shared'

// Data-access for runs: run rows + steps, the structured run-log feed, the
// filtered/paginated runs list, the run inspector load, cost derivation, and
// resume support. Pure functions over a `WfDb` handle.
// ---------------------------------------------------------------------------
// Runs + steps
// ---------------------------------------------------------------------------

export async function createRun(
  db: WfDb,
  input: {
    workflowVersionId: string
    triggerKind: string
    subjectId?: string
    correlationId?: string
    /** Marks this as an eval-produced run so the Runs explorer excludes it. */
    isEval?: boolean
    /** Stable 32-hex trace id for the run's Sentry spans + deep-link. */
    sentryTraceId?: string
  },
): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(wfRun).values({
    id,
    workflowVersionId: input.workflowVersionId,
    triggerKind: input.triggerKind,
    subjectId: input.subjectId ?? null,
    correlationId: input.correlationId ?? null,
    isEval: input.isEval ?? false,
    sentryTraceId: input.sentryTraceId ?? null,
    status: 'queued',
  })
  return id
}

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

/** Freeze the resolved reference manifest onto the run (once, at run start). */
export async function setRunManifest(
  db: WfDb,
  input: { runId: string; manifest: WfRunManifestEntry[] },
) {
  await db
    .update(wfRun)
    .set({ manifest: input.manifest })
    .where(eq(wfRun.id, input.runId))
}

export async function markRunRunning(
  db: WfDb,
  input: { runId: string; cloudflareRunId?: string },
) {
  await db
    .update(wfRun)
    .set({
      status: 'running',
      startedAt: new Date(),
      cloudflareRunId: input.cloudflareRunId ?? null,
    })
    .where(eq(wfRun.id, input.runId))
}

export async function finalizeRun(
  db: WfDb,
  input: { runId: string; output: unknown },
) {
  await db
    .update(wfRun)
    .set({
      status: 'completed',
      output: input.output ?? {},
      finishedAt: new Date(),
    })
    .where(eq(wfRun.id, input.runId))
}

export async function failRun(
  db: WfDb,
  input: { runId: string; error: string },
) {
  await db
    .update(wfRun)
    .set({ status: 'failed', error: input.error, finishedAt: new Date() })
    .where(eq(wfRun.id, input.runId))
}

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
/**
 * Every catalogued model's price, keyed for cost derivation. A run step records
 * `meta.model` as the provider-native id (`wf_model.modelId`); we key by that AND
 * the composite `id` so either resolves. One small table scan, shared by the runs
 * list (aggregate) and the run inspector (per node).
 */
export async function loadModelPriceMap(db: WfDb): Promise<ModelPriceMap> {
  const rows = await db
    .select({
      id: wfModel.id,
      modelId: wfModel.modelId,
      costPerMTok: wfModel.costPerMTok,
      promptPricePerMTok: wfModel.promptPricePerMTok,
      completionPricePerMTok: wfModel.completionPricePerMTok,
    })
    .from(wfModel)
  const map: ModelPriceMap = new Map()
  for (const r of rows) {
    const price: ModelPrice = {
      promptPerMTok: r.promptPricePerMTok,
      completionPerMTok: r.completionPricePerMTok,
      blendedPerMTok: r.costPerMTok,
    }
    map.set(r.modelId, price)
    // Don't let a composite-id entry clobber a bare-id match (what steps record).
    if (!map.has(r.id)) map.set(r.id, price)
  }
  return map
}

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

/** The run-inspector load shape: run, ordered steps, the version's graph. */
export async function getRun(db: WfDb, runId: string) {
  const run = (
    await db.select().from(wfRun).where(eq(wfRun.id, runId)).limit(1)
  )[0]
  if (!run) {
    return null
  }
  const rawSteps = await db
    .select()
    .from(wfRunStep)
    .where(eq(wfRunStep.runId, runId))
    .orderBy(asc(wfRunStep.sequence))
  // Derive each step's dollar cost from its token usage × the model's catalog
  // price, and roll the run's totals up for the header.
  const priceMap = await loadModelPriceMap(db)
  let costUsd: number | null = null
  let totalTokens: number | null = null
  const steps = rawSteps.map((s) => {
    const c = stepCost(s.meta, priceMap)
    if (c) {
      totalTokens = (totalTokens ?? 0) + c.tokens
      if (c.cost != null) costUsd = (costUsd ?? 0) + c.cost
    }
    // `-1` is the top-level sentinel (see wfRunStep) — surface it as null so the
    // client's `itemIndex: number | null` reads naturally.
    return {
      ...s,
      itemIndex: s.itemIndex === -1 ? null : s.itemIndex,
      costUsd: c?.cost ?? null,
    }
  })
  const logs = await getRunLogs(db, runId)
  const version = (
    await db
      .select()
      .from(wfWorkflowVersion)
      .where(eq(wfWorkflowVersion.id, run.workflowVersionId))
      .limit(1)
  )[0]
  const workflow = version
    ? (
        await db
          .select({ id: wfWorkflow.id, name: wfWorkflow.name })
          .from(wfWorkflow)
          .where(eq(wfWorkflow.id, version.workflowId))
          .limit(1)
      )[0]
    : undefined
  return {
    run,
    steps,
    logs,
    graph: version?.graph != null ? parseStoredGraph(version.graph) : null,
    versionNumber: version?.versionNumber ?? null,
    workflowId: workflow?.id ?? null,
    workflowName: workflow?.name ?? null,
    costUsd,
    totalTokens,
  }
}

/**
 * The workflow's latest (highest-numbered) version id — the target of a "retry
 * with the upgraded workflow" restart, which starts fresh on whatever is
 * current rather than the version the failed run froze. Null if the workflow
 * has no versions.
 */
export async function getLatestVersionId(
  db: WfDb,
  workflowId: string,
): Promise<string | null> {
  const v = await latestVersion(db, workflowId)
  return v?.id ?? null
}

/**
 * The completed steps of a prior run, in walk order — used to seed a resume.
 * The GraphWorkflow replays each into the scheduler (`report`) so those nodes
 * are treated as done and execution picks up at the first not-yet-completed
 * node (the one that failed). Excludes the trigger (seeded separately from the
 * trigger input) and any terminal Output.
 */
export async function loadResumeSteps(db: WfDb, runId: string) {
  const rows = await db
    .select({
      nodeId: wfRunStep.nodeId,
      nodeKind: wfRunStep.nodeKind,
      sequence: wfRunStep.sequence,
      input: wfRunStep.input,
      output: wfRunStep.output,
      meta: wfRunStep.meta,
      branchResult: wfRunStep.branchResult,
    })
    .from(wfRunStep)
    .where(
      and(
        eq(wfRunStep.runId, runId),
        eq(wfRunStep.status, 'completed'),
        // Top-level steps only (sentinel -1): resume seeds the top-level
        // scheduler, never an iteration's inner subgraph nodes.
        eq(wfRunStep.itemIndex, -1),
      ),
    )
    .orderBy(asc(wfRunStep.sequence))
  return rows.filter((r) => r.nodeKind !== 'trigger' && r.nodeKind !== 'output')
}

