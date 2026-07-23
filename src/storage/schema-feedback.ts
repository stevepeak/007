import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { createdAt, WF_FEEDBACK_RATINGS } from './schema-common'

// Human thumbs feedback on an answer, plus firm/staff-side triage state. One row
// per rated subject (a host "message" / answer) — `subject_id` is UNIQUE, so
// submitting is an upsert and clearing a rating deletes the row.
//
// The SDK never joins host tables, so every column the triage view renders is
// captured as an OPAQUE denormalized SNAPSHOT at rating time (rater name, client
// name, answer excerpt, a deep-link the host owns). Host identity stays opaque
// text, mirroring `wf_run`: `subject_id` (the rated item), `correlation_id` (a
// free-form host grouping ref, e.g. a client/org id), `rater_user_id` (the human
// who rated). No foreign keys point at host tables.
export const wfFeedback = sqliteTable(
  'wf_feedback',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    // Opaque host ref to the rated item (a message/answer id). UNIQUE — one
    // active rating per subject; submitting upserts on it.
    subjectId: text('subject_id').notNull().unique(),
    // Free-form host grouping ref (e.g. the client/org id) — powers the triage
    // "Client" facet + grouping. Nullable for hosts with no such notion.
    correlationId: text('correlation_id'),
    // Optional link to the `wf_run` that produced the rated answer.
    runId: text('run_id'),
    rating: text('rating', { enum: WF_FEEDBACK_RATINGS }).notNull(),
    // The rater's own comment (the customer's words).
    note: text('note'),
    // Staff-only triage note — NOT shown to the rater. Used to record how the
    // feedback was acted on ("fixed by …"), separate from the customer's `note`.
    // Survives acknowledgement toggles (only the rating/note reset re-opens the
    // item), so it stays as a running resolution log.
    internalNote: text('internal_note'),
    // --- Denormalized display snapshots (captured at submit time) ---
    // Excerpt of the rated answer, shown as the item's "On: …" line.
    body: text('body'),
    // A title for the subject's container (e.g. the chat title).
    subjectTitle: text('subject_title'),
    // Host-owned deep-link back to the subject; rendered as the "On: …" link when
    // present. Opaque to the SDK — the host builds it however its routing works.
    subjectUrl: text('subject_url'),
    // The human who left the rating.
    raterUserId: text('rater_user_id'),
    raterLabel: text('rater_label'),
    // The grouping's display name (e.g. the client/org name).
    correlationLabel: text('correlation_label'),
    // --- Triage acknowledgement state ---
    // `ack_at IS NULL` (a rating always exists on a row) = unacknowledged, i.e.
    // in the staff queue. Acknowledging stamps who + when; changing the
    // rating/note resets both to null (fresh signal to re-triage).
    ackAt: integer('ack_at', { mode: 'timestamp' }),
    ackByUserId: text('ack_by_user_id'),
    ackByLabel: text('ack_by_label'),
    createdAt: createdAt(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }),
  },
  (t) => [
    // Triage sweep — rated items newest-first.
    index('wf_feedback_rating_created_idx').on(t.rating, t.createdAt),
    // "Client" facet / grouping scans.
    index('wf_feedback_correlation_idx').on(t.correlationId),
  ],
)
