import { and, asc, eq, inArray, isNotNull, lt, sql, type SQL } from 'drizzle-orm'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'

import type { WfDb } from '../client'
import {
  wfEvalResult,
  wfEvalRun,
  wfFeedback,
  wfRun,
  wfRunLog,
  wfRunStep,
} from '../schema'

import { TERMINAL_RUN_STATUSES } from './runs-children'
import { chunk, selectChunked } from './shared'

// Wholesale run purge — the "clean slate" the Runs explorer's hidden
// Delete-all-runs control fires. Deliberately NOT a per-run delete: the
// explorer offers no single-row delete, and a full wipe is the only shape
// that leaves no dangling references behind.
//
// The wf_* tables carry no SQL foreign keys (host refs are opaque text), so
// "cascade" is explicit here. Everything downstream of a run goes with it:
//
//   wf_run          the runs themselves — INCLUDING eval-produced runs
//                   (is_eval = 1), which the explorer hides but which are
//                   still rows in the same table
//   wf_run_step     the machine trace (one row per node fired)
//   wf_run_log      the narrative progress feed
//   wf_eval_result  a result is a grade OF a wf_run; without the run it
//                   grades it is unreadable, so it goes too
//   wf_eval_run     the batch container for those results — now empty
//
// Two things are deliberately NOT deleted:
//   - Definitions (workflows, versions, agents, eval sets + rows, models).
//     Runs are history; the things that produced them stay.
//   - wf_feedback rows. Those are a human's thumbs on a host message, not a
//     byproduct of a run — deleting them would silently drop customer signal
//     from chats. Their `run_id` link is nulled instead, so no row points at
//     a run that no longer exists.

export type DeleteAllRunsResult = {
  runs: number
  steps: number
  logs: number
  evalResults: number
  evalRuns: number
  /** Feedback rows kept, but with their dangling `run_id` cleared. */
  feedbackUnlinked: number
}

async function countRows(
  db: WfDb,
  table: SQLiteTable,
  where?: SQL,
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(table)
    .where(where)
  return Number(rows[0]?.n ?? 0)
}

/**
 * Delete every run and everything derived from it. Returns what was removed so
 * the caller can report it. Counted before deleting (D1 doesn't give a portable
 * per-statement changed-rows count through Drizzle).
 */
export async function deleteAllRuns(db: WfDb): Promise<DeleteAllRunsResult> {
  const [runs, steps, logs, evalResults, evalRuns] = await Promise.all([
    countRows(db, wfRun),
    countRows(db, wfRunStep),
    countRows(db, wfRunLog),
    countRows(db, wfEvalResult),
    countRows(db, wfEvalRun),
  ])
  const linkedFeedback = await db
    .select({ n: sql<number>`count(*)` })
    .from(wfFeedback)
    .where(isNotNull(wfFeedback.runId))
  const feedbackUnlinked = Number(linkedFeedback[0]?.n ?? 0)

  // Children first, then the runs. Statements are sequential (not Promise.all)
  // so a mid-way failure can't leave the parent rows gone but their trace
  // behind — the far more confusing half-state.
  await db.delete(wfRunStep)
  await db.delete(wfRunLog)
  await db.delete(wfEvalResult)
  await db.delete(wfEvalRun)
  if (feedbackUnlinked > 0) {
    await db
      .update(wfFeedback)
      .set({ runId: null })
      .where(isNotNull(wfFeedback.runId))
  }
  await db.delete(wfRun)

  return { runs, steps, logs, evalResults, evalRuns, feedbackUnlinked }
}

/**
 * Delete the given runs and everything derived from them — the per-run form of
 * {@link deleteAllRuns}, with the same cascade and the same feedback rule.
 *
 * An eval run can span several workflows, so one only goes once none of its
 * results remain; a sweep that also graded another workflow keeps its row.
 */
export async function deleteRuns(db: WfDb, runIds: readonly string[]) {
  const evalRunIds = new Set<string>()
  // Sequential chunks, children before the runs, for the same reason as
  // `deleteAllRuns`: a mid-way failure must not strand a trace without its run.
  for (const ids of chunk(runIds)) {
    const results = await db
      .select({ evalRunId: wfEvalResult.evalRunId })
      .from(wfEvalResult)
      .where(inArray(wfEvalResult.wfRunId, ids))
    for (const r of results) evalRunIds.add(r.evalRunId)
    await db.delete(wfRunStep).where(inArray(wfRunStep.runId, ids))
    await db.delete(wfRunLog).where(inArray(wfRunLog.runId, ids))
    await db.delete(wfEvalResult).where(inArray(wfEvalResult.wfRunId, ids))
    await db
      .update(wfFeedback)
      .set({ runId: null })
      .where(inArray(wfFeedback.runId, ids))
    await db.delete(wfRun).where(inArray(wfRun.id, ids))
  }

  const stillGrading = await selectChunked([...evalRunIds], (ids) => {
    return db
      .selectDistinct({ id: wfEvalResult.evalRunId })
      .from(wfEvalResult)
      .where(inArray(wfEvalResult.evalRunId, ids))
  })
  const kept = new Set(stillGrading.map((r) => r.id))
  for (const ids of chunk([...evalRunIds].filter((id) => !kept.has(id)))) {
    await db.delete(wfEvalRun).where(inArray(wfEvalRun.id, ids))
  }
}

export type RunPrunePreview = {
  runs: number
  steps: number
  logs: number
  /** Feedback rows kept, but with their dangling `run_id` cleared. */
  feedbackUnlinked: number
}

/**
 * The runs a retention prune may delete: settled, created before the cutoff.
 *
 * - Eval runs stay: their results are the baseline drift reports compare against.
 * - `done` is not settled: arms of the graph are still executing.
 * - A run with an unsettled parent or child stays, because a live parent still
 *   reads its children. A settled child can outlive its parent; `listRuns` lists
 *   such an orphan at the top level.
 */
function prunableRuns(before: Date): SQL {
  const conditions = and(
    lt(wfRun.createdAt, before),
    eq(wfRun.isEval, false),
    inArray(wfRun.status, TERMINAL_RUN_STATUSES),
    sql`not exists (
      select 1 from wf_run as related
      where related.status not in ${TERMINAL_RUN_STATUSES}
        and (related.parent_run_id = ${wfRun.id} or related.id = ${wfRun.parentRunId})
    )`,
  )
  if (!conditions) throw new Error('prunableRuns: no conditions')
  return conditions
}

/** What {@link pruneRuns} would delete for this cutoff, across every page. */
export async function previewRunPrune(
  db: WfDb,
  args: { before: Date },
): Promise<RunPrunePreview> {
  const prunable = prunableRuns(args.before)
  const ids = db.select({ id: wfRun.id }).from(wfRun).where(prunable)
  const [runs, steps, logs, feedbackUnlinked] = await Promise.all([
    countRows(db, wfRun, prunable),
    countRows(db, wfRunStep, inArray(wfRunStep.runId, ids)),
    countRows(db, wfRunLog, inArray(wfRunLog.runId, ids)),
    countRows(db, wfFeedback, inArray(wfFeedback.runId, ids)),
  ])
  return { runs, steps, logs, feedbackUnlinked }
}

/**
 * Delete up to `limit` prunable runs, oldest first, and report how many remain.
 * Paged so one call stays inside a Worker's per-request query budget.
 */
export async function pruneRuns(
  db: WfDb,
  args: { before: Date; limit: number },
): Promise<{ runs: number; remaining: number }> {
  const prunable = prunableRuns(args.before)
  const page = await db
    .select({ id: wfRun.id })
    .from(wfRun)
    .where(prunable)
    .orderBy(asc(wfRun.createdAt))
    .limit(args.limit)
  await deleteRuns(
    db,
    page.map((r) => r.id),
  )
  return { runs: page.length, remaining: await countRows(db, wfRun, prunable) }
}
