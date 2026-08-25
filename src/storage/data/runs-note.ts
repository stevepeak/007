import { eq } from 'drizzle-orm'

import type { WfDb } from '../client'
import { wfRun } from '../schema'

// The run note: one free-form Markdown field on `wf_run`, shared rather than
// private, recording why a run went the way it did. Its own module because a
// note is an annotation, not a lifecycle transition — nothing here participates
// in the queued → running → terminal machine in `runs-lifecycle`.

/** Longest note we'll store. Generous for prose, short of a blob. */
export const RUN_NOTE_MAX_LENGTH = 8000

/**
 * Set (or clear, with `null`) a run's note. Last write wins: the note is a
 * shared scratchpad, and two people editing the same run's note at once is rare
 * enough that a merge or a lock would cost more than it saves.
 *
 * Returns `false` when no run matched, so the caller can 404 rather than
 * silently swallow a note written against a purged run.
 */
export async function setRunNote(
  db: WfDb,
  input: { runId: string; note: string | null },
): Promise<boolean> {
  const rows = await db
    .update(wfRun)
    .set({ note: input.note?.slice(0, RUN_NOTE_MAX_LENGTH) ?? null })
    .where(eq(wfRun.id, input.runId))
    .returning({ id: wfRun.id })
  return rows.length > 0
}
