import { sql } from 'drizzle-orm'
import { integer } from 'drizzle-orm/sqlite-core'

// The SDK owns these tables. Everything is prefixed `wf_` so the schema can
// coexist with any host schema in the same D1 database. Workflows and agents
// are a single GLOBAL set — every caller shares the same definitions, so there
// is no tenant partition; edit access is gatekept by the host. Run identity is
// still OPAQUE: `subjectId` ties a run to a host entity (a chat, a document, …)
// and `correlationId` is a free-form host reference. No foreign keys point at
// host tables — the host maps its own ids into these text columns.

export const WF_RUN_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const

export const WF_RUN_STEP_STATUSES = [
  'running',
  'completed',
  'failed',
  'skipped',
] as const

// An eval run shares the run lifecycle vocabulary; each per-row result is a
// three-way pass/fail/error.
export const WF_EVAL_TARGET_KINDS = ['agent', 'workflow'] as const
export const WF_EVAL_RESULT_STATUSES = ['pass', 'fail', 'error'] as const

// Thumbs feedback a human leaves on an answer — the two sentiments the widget
// and triage view speak in. Clearing feedback deletes the row (no third state).
export const WF_FEEDBACK_RATINGS = ['up', 'down'] as const

export function createdAt() {
  return integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`)
}
