import { isNotNull, sql } from 'drizzle-orm'
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

async function countRows(db: WfDb, table: SQLiteTable): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)` }).from(table)
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
