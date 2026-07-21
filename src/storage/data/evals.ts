import { and, asc, desc, eq, sql } from 'drizzle-orm'

import {
  checkTreeSchema,
  evalFixturesSchema,
  evalInitialConditionSchema,
  type CheckResult,
  type CheckTree,
  type EvalFixtures,
  type EvalInitialCondition,
  type EvalRowSnapshot,
} from '../../eval/checks'
import type { WfDb } from '../client'
import type {
  WF_EVAL_RESULT_STATUSES,
  WF_EVAL_TARGET_KINDS,
  WF_RUN_STATUSES,
} from '../schema'
import { wfEvalResult, wfEvalRow, wfEvalRun, wfEvalSet } from '../schema'

import { clampLimit, pickDefined } from './shared'

const EVAL_RUN_PAGE_MAX = 200

// Data-access for evals: suites (sets), cases (rows), test runs, and per-row
// results. Persistence only — grading lives in `../../eval/grade`.
// ---------------------------------------------------------------------------
// Evals — suites (sets), cases (rows), test runs, per-row results
// ---------------------------------------------------------------------------
//
// Persistence only; grading (evaluate checks → verdicts) is Phase 3 (`grade.ts`)
// and starting the real run is a host-wired hook (Phase 4). JSON columns are
// validated against `src/eval/checks.ts` on write and cast on read.

export type EvalTargetKind = (typeof WF_EVAL_TARGET_KINDS)[number]
export type EvalResultStatus = (typeof WF_EVAL_RESULT_STATUSES)[number]

export type EvalRowRecord = {
  id: string
  setId: string
  name: string
  description: string | null
  initialCondition: EvalInitialCondition
  fixtures: EvalFixtures
  checks: CheckTree
  sortOrder: number
  archived: boolean
}

function toEvalRow(r: typeof wfEvalRow.$inferSelect): EvalRowRecord {
  return {
    id: r.id,
    setId: r.setId,
    name: r.name,
    description: r.description,
    initialCondition: r.initialCondition as EvalInitialCondition,
    fixtures: r.fixtures as EvalFixtures,
    checks: r.checks as CheckTree,
    sortOrder: r.sortOrder,
    archived: r.archived,
  }
}

/** Eval sets, newest first, each with its (non-archived) row count. */
export async function listEvalSets(
  db: WfDb,
  opts?: { includeArchived?: boolean },
) {
  const rows = await db
    .select({
      id: wfEvalSet.id,
      name: wfEvalSet.name,
      description: wfEvalSet.description,
      targetKind: wfEvalSet.targetKind,
      targetId: wfEvalSet.targetId,
      targetVersion: wfEvalSet.targetVersion,
      triggerKind: wfEvalSet.triggerKind,
      archived: wfEvalSet.archived,
      createdAt: wfEvalSet.createdAt,
      updatedAt: wfEvalSet.updatedAt,
      rowCount: sql<number>`(select count(*) from ${wfEvalRow} where ${wfEvalRow.setId} = ${wfEvalSet.id} and ${wfEvalRow.archived} = 0)`,
    })
    .from(wfEvalSet)
    .where(opts?.includeArchived ? undefined : eq(wfEvalSet.archived, false))
    .orderBy(desc(wfEvalSet.createdAt))
  return rows
}

/** A set with its rows (ordered), or null if missing. */
export async function getEvalSet(db: WfDb, setId: string) {
  const [set] = await db
    .select()
    .from(wfEvalSet)
    .where(eq(wfEvalSet.id, setId))
    .limit(1)
  if (!set) return null
  const rows = await db
    .select()
    .from(wfEvalRow)
    .where(and(eq(wfEvalRow.setId, setId), eq(wfEvalRow.archived, false)))
    .orderBy(asc(wfEvalRow.sortOrder))
  return { set, rows: rows.map(toEvalRow) }
}

/**
 * One row plus its parent set's target/trigger identity — everything
 * `startEvalRun`/`gradeEvalResult` need to launch and grade the row without a
 * separate set fetch. Null if the row is missing or archived.
 */
export async function getEvalRow(db: WfDb, rowId: string) {
  const [row] = await db
    .select()
    .from(wfEvalRow)
    .where(and(eq(wfEvalRow.id, rowId), eq(wfEvalRow.archived, false)))
    .limit(1)
  if (!row) return null
  const [set] = await db
    .select({
      id: wfEvalSet.id,
      name: wfEvalSet.name,
      targetKind: wfEvalSet.targetKind,
      targetId: wfEvalSet.targetId,
      targetVersion: wfEvalSet.targetVersion,
      triggerKind: wfEvalSet.triggerKind,
    })
    .from(wfEvalSet)
    .where(eq(wfEvalSet.id, row.setId))
    .limit(1)
  if (!set) return null
  return { row: toEvalRow(row), set }
}

export async function createEvalSet(
  db: WfDb,
  input: {
    name: string
    description?: string
    targetKind: EvalTargetKind
    targetId: string
    targetVersion?: number | null
    triggerKind: string
    createdBy?: string
  },
): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(wfEvalSet).values({
    id,
    name: input.name,
    description: input.description ?? null,
    targetKind: input.targetKind,
    targetId: input.targetId,
    targetVersion: input.targetVersion ?? null,
    triggerKind: input.triggerKind,
    createdBy: input.createdBy ?? null,
  })
  return id
}

export async function updateEvalSet(
  db: WfDb,
  input: {
    setId: string
    name?: string
    description?: string | null
    targetKind?: EvalTargetKind
    targetId?: string
    targetVersion?: number | null
    triggerKind?: string
    archived?: boolean
  },
) {
  await db
    .update(wfEvalSet)
    .set({
      ...pickDefined(input, [
        'name',
        'description',
        'targetKind',
        'targetId',
        'targetVersion',
        'triggerKind',
        'archived',
      ]),
      updatedAt: new Date(),
    })
    .where(eq(wfEvalSet.id, input.setId))
}

/** Hard-delete a set and its rows (results/runs are kept for history). */
export async function deleteEvalSet(db: WfDb, setId: string) {
  await db.delete(wfEvalRow).where(eq(wfEvalRow.setId, setId))
  await db.delete(wfEvalSet).where(eq(wfEvalSet.id, setId))
}

/** Create (no id) or update (id given) a row. Validates the JSON payloads. */
export async function upsertEvalRow(
  db: WfDb,
  input: {
    id?: string
    setId: string
    name: string
    description?: string | null
    initialCondition?: EvalInitialCondition
    fixtures?: EvalFixtures
    checks?: CheckTree
    sortOrder?: number
  },
): Promise<string> {
  const initialCondition = evalInitialConditionSchema.parse(
    input.initialCondition ?? {},
  )
  const fixtures = evalFixturesSchema.parse(input.fixtures ?? {})
  const checks = checkTreeSchema.parse(
    input.checks ?? { op: 'and', checks: [] },
  )
  if (input.id) {
    await db
      .update(wfEvalRow)
      .set({
        name: input.name,
        initialCondition,
        fixtures,
        checks,
        updatedAt: new Date(),
        ...pickDefined(input, ['description', 'sortOrder']),
      })
      .where(eq(wfEvalRow.id, input.id))
    return input.id
  }
  const id = crypto.randomUUID()
  await db.insert(wfEvalRow).values({
    id,
    setId: input.setId,
    name: input.name,
    description: input.description ?? null,
    initialCondition,
    fixtures,
    checks,
    sortOrder: input.sortOrder ?? 0,
  })
  return id
}

/** Soft-delete a row (archived rows drop out of the set + its row count). */
export async function deleteEvalRow(db: WfDb, rowId: string) {
  await db
    .update(wfEvalRow)
    .set({ archived: true, updatedAt: new Date() })
    .where(eq(wfEvalRow.id, rowId))
}

export async function createEvalRun(
  db: WfDb,
  input: { setIds: string[]; total?: number; createdBy?: string },
): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(wfEvalRun).values({
    id,
    setIds: input.setIds,
    total: input.total ?? 0,
    status: 'queued',
    createdBy: input.createdBy ?? null,
  })
  return id
}

/** Patch an eval run's lifecycle + rolled-up counts/score. */
export async function updateEvalRun(
  db: WfDb,
  input: {
    evalRunId: string
    status?: (typeof WF_RUN_STATUSES)[number]
    total?: number
    passed?: number
    failed?: number
    score?: number | null
    startedAt?: Date
    finishedAt?: Date
  },
) {
  await db
    .update(wfEvalRun)
    .set(
      pickDefined(input, [
        'status',
        'total',
        'passed',
        'failed',
        'score',
        'startedAt',
        'finishedAt',
      ]),
    )
    .where(eq(wfEvalRun.id, input.evalRunId))
}

export async function listEvalRuns(db: WfDb, opts?: { limit?: number }) {
  return await db
    .select()
    .from(wfEvalRun)
    .orderBy(desc(wfEvalRun.createdAt))
    .limit(clampLimit(opts?.limit, { fallback: 50, max: EVAL_RUN_PAGE_MAX }))
}

/** An eval run with its per-row results, or null if missing. */
export async function getEvalRun(db: WfDb, evalRunId: string) {
  const [run] = await db
    .select()
    .from(wfEvalRun)
    .where(eq(wfEvalRun.id, evalRunId))
    .limit(1)
  if (!run) return null
  const results = await db
    .select()
    .from(wfEvalResult)
    .where(eq(wfEvalResult.evalRunId, evalRunId))
    .orderBy(asc(wfEvalResult.createdAt))
  return { run, results }
}

/**
 * Assemble the frozen {@link EvalRowSnapshot} for a result from the row + its
 * parent set (as returned by {@link getEvalRow}). Pure — the caller hashes and
 * persists it. See EvalRowSnapshot for why this replaces per-entity versioning.
 */
export function buildEvalSnapshot(
  row: EvalRowRecord,
  set: {
    id: string
    name: string
    targetKind: string
    targetId: string
    targetVersion: number | null
    triggerKind: string
  },
): EvalRowSnapshot {
  return {
    row: {
      name: row.name,
      description: row.description,
      initialCondition: row.initialCondition,
      fixtures: row.fixtures,
      checks: row.checks,
    },
    target: {
      setId: set.id,
      setName: set.name,
      targetKind: set.targetKind,
      targetId: set.targetId,
      targetVersion: set.targetVersion,
      triggerKind: set.triggerKind,
    },
  }
}

// Deterministic JSON with recursively sorted object keys, so the same logical
// snapshot always produces the same hash regardless of property insertion order.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (k) =>
        `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
    )
  return `{${entries.join(',')}}`
}

/**
 * sha256 (hex) over a snapshot's reproducibility-relevant fields: the Sample
 * inputs (initialCondition + fixtures), the checks, and the Goal target
 * identity. Excludes cosmetic name/description so a rename isn't a "change".
 * Lets callers detect whether a Sample's effective definition changed between
 * two runs, and dedup identical snapshots — the job a version counter used to do.
 */
export async function hashEvalSnapshot(
  snapshot: EvalRowSnapshot,
): Promise<string> {
  const semantic = {
    initialCondition: snapshot.row.initialCondition,
    fixtures: snapshot.row.fixtures,
    checks: snapshot.row.checks,
    targetKind: snapshot.target.targetKind,
    targetId: snapshot.target.targetId,
    targetVersion: snapshot.target.targetVersion,
    triggerKind: snapshot.target.triggerKind,
  }
  const bytes = new TextEncoder().encode(stableStringify(semantic))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Insert a per-row result placeholder (before or after the row's run grades). */
export async function insertEvalResult(
  db: WfDb,
  input: {
    evalRunId: string
    rowId: string
    wfRunId?: string
    status: EvalResultStatus
    score?: number | null
    checkResults?: CheckResult[]
    /** Frozen state this result ran against — see buildEvalSnapshot. */
    snapshot?: EvalRowSnapshot | null
    /** sha256 of `snapshot` — see hashEvalSnapshot. */
    snapshotHash?: string | null
  },
): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(wfEvalResult).values({
    id,
    evalRunId: input.evalRunId,
    rowId: input.rowId,
    wfRunId: input.wfRunId ?? null,
    status: input.status,
    score: input.score ?? null,
    checkResults: input.checkResults ?? [],
    snapshot: input.snapshot ?? null,
    snapshotHash: input.snapshotHash ?? null,
  })
  return id
}

/** Write a graded verdict onto an existing result. */
export async function updateEvalResult(
  db: WfDb,
  input: {
    resultId: string
    wfRunId?: string
    status?: EvalResultStatus
    score?: number | null
    checkResults?: CheckResult[]
  },
) {
  await db
    .update(wfEvalResult)
    .set(pickDefined(input, ['wfRunId', 'status', 'score', 'checkResults']))
    .where(eq(wfEvalResult.id, input.resultId))
}

