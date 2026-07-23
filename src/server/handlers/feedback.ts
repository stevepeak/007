import {
  deleteFeedback,
  getFeedbackForSubjects,
  listFeedback,
  setFeedbackAck,
  setFeedbackInternalNote,
  upsertFeedback,
  type FeedbackRecord,
} from '../../storage/data'
import type {
  WfFeedbackListInput,
  WfFeedbackRow,
  WfFeedbackSubmitInput,
} from '../protocol'

import {
  str,
  toEpoch,
  type CreateWfSdkHandlersOptions,
  type WfHandlers,
} from './shared'

// Map a stored feedback row to its wire DTO (timestamps → epoch millis).
function rowToDto(r: FeedbackRecord): WfFeedbackRow {
  return {
    subjectId: r.subjectId,
    correlationId: r.correlationId,
    runId: r.runId,
    rating: r.rating,
    note: r.note,
    internalNote: r.internalNote,
    body: r.body,
    subjectTitle: r.subjectTitle,
    subjectUrl: r.subjectUrl,
    raterUserId: r.raterUserId,
    raterLabel: r.raterLabel,
    correlationLabel: r.correlationLabel,
    acknowledgedAt: toEpoch(r.ackAt),
    ackByUserId: r.ackByUserId,
    ackByLabel: r.ackByLabel,
    createdAt: toEpoch(r.createdAt) ?? 0,
  }
}

export function buildFeedbackHandlers<TDeps>(
  _opts: CreateWfSdkHandlersOptions<TDeps>,
): Pick<
  WfHandlers,
  | 'submitFeedback'
  | 'listFeedback'
  | 'setFeedbackAcknowledged'
  | 'setFeedbackInternalNote'
  | 'getFeedbackForSubjects'
> {
  return {
    // Submit / change / clear a thumb. `rating: null` deletes the row. The rater
    // id is taken from the authenticated context (never the input); the input's
    // `raterLabel` is just the display snapshot for triage.
    submitFeedback: async (c) => {
      const input = c.params as WfFeedbackSubmitInput
      const subjectId = str(input, 'subjectId')
      if (input.rating == null) {
        await deleteFeedback(c.db, subjectId)
        return { ok: true as const }
      }
      await upsertFeedback(c.db, {
        subjectId,
        rating: input.rating,
        note: input.note ?? null,
        correlationId: input.correlationId ?? null,
        runId: input.runId ?? null,
        body: input.body ?? null,
        subjectTitle: input.subjectTitle ?? null,
        subjectUrl: input.subjectUrl ?? null,
        correlationLabel: input.correlationLabel ?? null,
        raterUserId: c.ctx.userId ?? null,
        raterLabel: input.raterLabel ?? null,
      })
      return { ok: true as const }
    },

    listFeedback: async (c) => {
      const input = (c.params ?? {}) as WfFeedbackListInput
      const result = await listFeedback(c.db, {
        ratings: input.ratings,
        ackState: input.ackState,
        correlationIds: input.correlationIds,
        raterIds: input.raterIds,
        search: input.search?.trim() || undefined,
      })
      return {
        rows: result.rows.map(rowToDto),
        correlations: result.correlations,
        raters: result.raters,
      }
    },

    setFeedbackAcknowledged: async (c) => {
      const subjectId = str(c.params, 'subjectId')
      const acknowledged =
        (c.params as { acknowledged?: boolean }).acknowledged === true
      await setFeedbackAck(c.db, {
        subjectId,
        acknowledged,
        ackByUserId: c.ctx.userId ?? null,
      })
      return { ok: true as const }
    },

    setFeedbackInternalNote: async (c) => {
      const subjectId = str(c.params, 'subjectId')
      const raw = (c.params as { note?: unknown }).note
      const note = typeof raw === 'string' && raw.trim() ? raw.trim() : null
      await setFeedbackInternalNote(c.db, { subjectId, note })
      return { ok: true as const }
    },

    getFeedbackForSubjects: async (c) => {
      const subjectIds = (c.params as { subjectIds?: unknown }).subjectIds
      const ids = Array.isArray(subjectIds)
        ? subjectIds.filter((s): s is string => typeof s === 'string')
        : []
      const rows = await getFeedbackForSubjects(c.db, ids)
      return rows.map(rowToDto)
    },
  }
}
