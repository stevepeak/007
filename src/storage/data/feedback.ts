import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  or,
  type SQL,
} from 'drizzle-orm'

import type { WfDb } from '../client'
import { wfFeedback } from '../schema'
import type { WF_FEEDBACK_RATINGS } from '../schema-common'

import { selectChunked } from './shared'

// Data-access for thumbs feedback + triage. Pure functions over `WfDb`, no auth
// and no tenancy — the host gatekeeps the route and passes opaque ids/labels.
// One row per rated subject; `subject_id` is UNIQUE so submitting is an upsert
// and clearing deletes the row. See `schema-feedback.ts` for the snapshot model.

export type FeedbackRating = (typeof WF_FEEDBACK_RATINGS)[number]

export type FeedbackRecord = typeof wfFeedback.$inferSelect

// The write payload for a submitted thumb. `rating` is required here (clearing
// goes through {@link deleteFeedback}); everything else is an optional opaque
// snapshot the triage view renders.
export type SubmitFeedbackInput = {
  subjectId: string
  rating: FeedbackRating
  note?: string | null
  correlationId?: string | null
  runId?: string | null
  body?: string | null
  subjectTitle?: string | null
  subjectUrl?: string | null
  raterUserId?: string | null
  raterLabel?: string | null
  correlationLabel?: string | null
}

export type FeedbackAckState = 'acknowledged' | 'unacknowledged'

export type ListFeedbackFilters = {
  ratings?: FeedbackRating[]
  ackState?: FeedbackAckState
  correlationIds?: string[]
  raterIds?: string[]
  search?: string
}

export type FeedbackFacet = { id: string; label: string | null }

export type ListFeedbackResult = {
  rows: FeedbackRecord[]
  /** Distinct client/org groupings that have any feedback (filter dropdown). */
  correlations: FeedbackFacet[]
  /** Distinct raters that have left any feedback (filter dropdown). */
  raters: FeedbackFacet[]
}

// Cap the triage sweep — plenty for a review queue, bounds the payload.
const LIST_LIMIT = 300

/**
 * Build (without executing) the upsert statement, so a host can compose it into
 * its own `db.batch([...])` — keeping the feedback write atomic with, e.g., an
 * audit-event insert. Upserts on `subject_id`; changing the rating or note
 * RESETS acknowledgement (a flipped thumb is fresh signal the staff hasn't acted
 * on). {@link upsertFeedback} is just this builder awaited. Prefer the helpers
 * to touching {@link wfFeedback} directly — they keep the write logic (and the
 * ack-reset) owned by the SDK as the column set evolves.
 */
export function buildUpsertFeedbackStatement(
  db: WfDb,
  input: SubmitFeedbackInput,
) {
  const now = new Date()
  const snapshot = {
    rating: input.rating,
    note: input.note ?? null,
    correlationId: input.correlationId ?? null,
    runId: input.runId ?? null,
    body: input.body ?? null,
    subjectTitle: input.subjectTitle ?? null,
    subjectUrl: input.subjectUrl ?? null,
    raterUserId: input.raterUserId ?? null,
    raterLabel: input.raterLabel ?? null,
    correlationLabel: input.correlationLabel ?? null,
  }
  return db
    .insert(wfFeedback)
    .values({ subjectId: input.subjectId, ...snapshot, updatedAt: now })
    .onConflictDoUpdate({
      target: wfFeedback.subjectId,
      set: {
        ...snapshot,
        updatedAt: now,
        // Re-open triage on any change.
        ackAt: null,
        ackByUserId: null,
        ackByLabel: null,
      },
    })
}

/**
 * Build (without executing) the delete statement — clearing a rating removes the
 * row entirely. Composable into a host `db.batch([...])`; {@link deleteFeedback}
 * is this builder awaited.
 */
export function buildDeleteFeedbackStatement(db: WfDb, subjectId: string) {
  return db.delete(wfFeedback).where(eq(wfFeedback.subjectId, subjectId))
}

/**
 * Insert-or-update a subject's rating. Upserts on `subject_id`. Changing the
 * rating or note RESETS acknowledgement (a flipped thumb is fresh signal the
 * staff hasn't acted on), mirroring the host's original behavior.
 */
export async function upsertFeedback(
  db: WfDb,
  input: SubmitFeedbackInput,
): Promise<void> {
  await buildUpsertFeedbackStatement(db, input)
}

/** Clear a subject's feedback entirely (the human removed their thumb). */
export async function deleteFeedback(
  db: WfDb,
  subjectId: string,
): Promise<void> {
  await buildDeleteFeedbackStatement(db, subjectId)
}

/**
 * Set (or clear, with `null`) the staff-only internal note — the resolution log
 * that lives alongside the customer's `note`. Independent of the rating, so it
 * survives acknowledgement toggles.
 */
export async function setFeedbackInternalNote(
  db: WfDb,
  input: { subjectId: string; note: string | null },
): Promise<FeedbackRecord | null> {
  const rows = await db
    .update(wfFeedback)
    .set({ internalNote: input.note })
    .where(eq(wfFeedback.subjectId, input.subjectId))
    .returning()
  return rows[0] ?? null
}

/** Toggle a subject's triage acknowledgement, stamping who + when. */
export async function setFeedbackAck(
  db: WfDb,
  input: {
    subjectId: string
    acknowledged: boolean
    ackByUserId?: string | null
    ackByLabel?: string | null
  },
): Promise<FeedbackRecord | null> {
  const rows = await db
    .update(wfFeedback)
    .set({
      ackAt: input.acknowledged ? new Date() : null,
      ackByUserId: input.acknowledged ? (input.ackByUserId ?? null) : null,
      ackByLabel: input.acknowledged ? (input.ackByLabel ?? null) : null,
    })
    .where(eq(wfFeedback.subjectId, input.subjectId))
    .returning()
  return rows[0] ?? null
}

/**
 * The triage list — every rated subject, newest-first, filtered, plus the
 * distinct client + rater facets that populate the filter dropdowns (computed
 * across ALL feedback, so a facet stays listed even when the active filter
 * hides its rows).
 */
export async function listFeedback(
  db: WfDb,
  filters: ListFeedbackFilters = {},
): Promise<ListFeedbackResult> {
  const conds: SQL[] = []
  if (filters.ratings && filters.ratings.length > 0) {
    conds.push(inArray(wfFeedback.rating, filters.ratings))
  }
  if (filters.ackState === 'acknowledged') {
    conds.push(isNotNull(wfFeedback.ackAt))
  } else if (filters.ackState === 'unacknowledged') {
    conds.push(isNull(wfFeedback.ackAt))
  }
  // Deliberately NOT chunked, unlike the id lookups elsewhere in this file:
  // these two are AND-ed into one statement, so splitting them independently
  // would mean a cross-product of queries — and the shared `orderBy … limit`
  // would then need a top-N merge across it. They're facet-dropdown
  // selections, so the protocol schema caps each at 40 instead (see
  // `wfInputSchemas`): 80 ids plus the ratings/search/limit binds stays inside
  // D1's 100-parameter budget with room to spare. If a real filter ever needs
  // more than 40 facets, that's the point to rework this into a top-N merge.
  if (filters.correlationIds && filters.correlationIds.length > 0) {
    conds.push(inArray(wfFeedback.correlationId, filters.correlationIds))
  }
  if (filters.raterIds && filters.raterIds.length > 0) {
    conds.push(inArray(wfFeedback.raterUserId, filters.raterIds))
  }
  if (filters.search) {
    const term = `%${filters.search}%`
    const clause = or(
      like(wfFeedback.note, term),
      like(wfFeedback.body, term),
    )
    if (clause) conds.push(clause)
  }

  const rows = await db
    .select()
    .from(wfFeedback)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(wfFeedback.createdAt))
    .limit(LIST_LIMIT)

  // Facets over the whole table (unfiltered) so the dropdowns list everyone.
  const all = await db
    .select({
      correlationId: wfFeedback.correlationId,
      correlationLabel: wfFeedback.correlationLabel,
      raterUserId: wfFeedback.raterUserId,
      raterLabel: wfFeedback.raterLabel,
    })
    .from(wfFeedback)

  const correlations = new Map<string, FeedbackFacet>()
  const raters = new Map<string, FeedbackFacet>()
  for (const r of all) {
    if (r.correlationId && !correlations.has(r.correlationId)) {
      correlations.set(r.correlationId, {
        id: r.correlationId,
        label: r.correlationLabel,
      })
    }
    if (r.raterUserId && !raters.has(r.raterUserId)) {
      raters.set(r.raterUserId, { id: r.raterUserId, label: r.raterLabel })
    }
  }

  return {
    rows,
    correlations: [...correlations.values()],
    raters: [...raters.values()],
  }
}

/**
 * Current rating/note for a set of subjects — the host's read path uses this to
 * re-hydrate the thumbs widget when it re-renders a conversation.
 *
 * Hosts pass one subject id per rendered message, and a chat's message list
 * isn't paged, so `subjectIds` routinely runs past D1's parameter ceiling on a
 * long conversation — hence the chunking. Rows come back unordered either way;
 * callers key them by `subjectId`.
 */
export async function getFeedbackForSubjects(
  db: WfDb,
  subjectIds: string[],
): Promise<FeedbackRecord[]> {
  return await selectChunked(subjectIds, (ids) =>
    db.select().from(wfFeedback).where(inArray(wfFeedback.subjectId, ids)),
  )
}
