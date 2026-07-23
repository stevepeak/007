// Wire DTOs for the thumbs-feedback + triage surface. Pure types, no React / no
// Drizzle. Host identity stays opaque (see `schema-feedback.ts`): `subjectId`
// (the rated item), `correlationId` (a host grouping ref), `raterUserId`. Every
// human-readable field is a denormalized snapshot the host captured at submit
// time — the SDK never joins host tables to resolve names.

export type WfFeedbackRating = 'up' | 'down'

export type WfFeedbackAckState = 'acknowledged' | 'unacknowledged'

// One rated subject, as the triage list renders it. Timestamps are epoch millis.
export type WfFeedbackRow = {
  subjectId: string
  correlationId: string | null
  runId: string | null
  rating: WfFeedbackRating
  /** The rater's own comment (the customer's words). */
  note: string | null
  /** Staff-only triage note — not shown to the rater. A resolution log. */
  internalNote: string | null
  /** Snapshot excerpt of the rated answer (the "On: …" line). */
  body: string | null
  subjectTitle: string | null
  /** Host-owned deep-link back to the subject; null when the host wired none. */
  subjectUrl: string | null
  raterUserId: string | null
  raterLabel: string | null
  correlationLabel: string | null
  acknowledgedAt: number | null
  ackByUserId: string | null
  ackByLabel: string | null
  createdAt: number
}

// What the client-facing thumbs widget submits. `rating: null` CLEARS the
// feedback (deletes the row). The rater is stamped server-side from the
// authenticated context — never trusted off this input.
export type WfFeedbackSubmitInput = {
  subjectId: string
  rating: WfFeedbackRating | null
  note?: string | null
  /** Opaque host grouping ref (e.g. a client/org id). */
  correlationId?: string | null
  runId?: string | null
  // Denormalized display snapshots — captured now so triage needs no host join.
  body?: string | null
  subjectTitle?: string | null
  subjectUrl?: string | null
  /** Display label for the current grouping (e.g. the client name). */
  correlationLabel?: string | null
  /** Display label for the rater (name/email). The id comes from server ctx. */
  raterLabel?: string | null
}

export type WfFeedbackListInput = {
  ratings?: WfFeedbackRating[]
  ackState?: WfFeedbackAckState
  correlationIds?: string[]
  raterIds?: string[]
  search?: string
}

export type WfFeedbackFacet = { id: string; label: string | null }

export type WfFeedbackListResult = {
  rows: WfFeedbackRow[]
  /** Distinct client/org groupings for the "Client" filter dropdown. */
  correlations: WfFeedbackFacet[]
  /** Distinct raters for the "User" filter dropdown. */
  raters: WfFeedbackFacet[]
}
