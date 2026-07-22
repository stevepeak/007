import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

import { createdAt } from './schema-common'

// A workflow — a globally shared, editable unit. Versions are immutable
// snapshots; the draft is the in-progress sidecar.
export const wfWorkflow = sqliteTable('wf_workflow', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text('name').notNull(),
  description: text('description'),
  // Hidden workflows are machinery, not authored content — kept out of the
  // Workflows list. Used by the auto-generated agent-eval wrapper (a
  // `trigger → agent → output` graph created once per agent target so an agent
  // eval runs through the same GraphWorkflow path as a workflow eval).
  hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
  // Archived workflows are retired: kept out of the Workflows list and, most
  // importantly, never resolved for a trigger — an archived workflow does not
  // run when its assigned event fires (see `resolveAssignedVersion`). Soft
  // retirement, reversible by unarchiving; distinct from a hard `deleteWorkflow`.
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  createdBy: text('created_by'),
  createdAt: createdAt(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
})

// Immutable published graph snapshots.
export const wfWorkflowVersion = sqliteTable(
  'wf_workflow_version',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workflowId: text('workflow_id').notNull(),
    versionNumber: integer('version_number').notNull(),
    graph: text('graph', { mode: 'json' }).notNull(),
    // The human's own note about what changed (written in the publish dialog).
    changeNote: text('change_note'),
    // The AI's git-style summary of the graph diff: a one-line subject
    // (`ai_summary_short`) and an optional longer body (`ai_summary_long`).
    // Null until the summary is generated — it may be filled at publish time
    // (if the dialog's summary landed) or written asynchronously afterward.
    aiSummaryShort: text('ai_summary_short'),
    aiSummaryLong: text('ai_summary_long'),
    createdBy: text('created_by'),
    publishedBy: text('published_by'),
    publishedAt: integer('published_at', { mode: 'timestamp' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('wf_workflow_version_workflow_number_idx').on(
      t.workflowId,
      t.versionNumber,
    ),
  ],
)

// 1:1 editable sidecar for a workflow. `baseVersionId` records the version the
// draft was forked from.
export const wfWorkflowDraft = sqliteTable('wf_workflow_draft', {
  workflowId: text('workflow_id').primaryKey(),
  graph: text('graph', { mode: 'json' }).notNull(),
  baseVersionId: text('base_version_id'),
  lastEditedBy: text('last_edited_by'),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
})

// Binds a trigger kind to the workflow that should run for it. One global
// mapping — a trigger kind resolves to a single workflow for everyone.
export const wfWorkflowAssignment = sqliteTable(
  'wf_workflow_assignment',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    triggerKind: text('trigger_kind').notNull(),
    workflowId: text('workflow_id').notNull(),
    assignedBy: text('assigned_by'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('wf_assignment_trigger_idx').on(t.triggerKind)],
)
