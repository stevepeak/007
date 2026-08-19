import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

import { createdAt } from './schema-common'

// A reusable agent — same lifecycle as workflows: a globally shared, editable
// unit with immutable published versions and a 1:1 draft sidecar. Name, icon,
// and color are display metadata edited in place; the versioned behavior
// (model, prompt, tools, output contract) lives in `config` on each version.
// Workflow agent nodes reference an agent by `wf_agent.id` and float to its
// latest published version; a run freezes the resolved config in its manifest.
export const wfAgent = sqliteTable('wf_agent', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  // Stable, human-authored identity that survives across environments (local /
  // prod / other host projects) and is invariant under renames — unlike `id`
  // (a per-DB random UUID) and `name` (editable display metadata). It is the key
  // the import/export spec matches on, and what graph agent-refs carry in the
  // portable spec (translated to/from `id` only at the export/import boundary).
  // Nullable so existing rows migrate cleanly; `exportSpec` backfills any missing
  // slug (slugified from `name`) and persists it.
  slug: text('slug'),
  name: text('name').notNull(),
  description: text('description'),
  // Lucide icon name + a color token — purely for the agent cards.
  icon: text('icon'),
  color: text('color'),
  // Soft-delete: an archived agent drops out of the agents list and the workflow
  // node picker, but its row + versions are kept so historical runs stay
  // reproducible. Archiving is blocked while a live workflow still references it.
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  createdBy: text('created_by'),
  createdAt: createdAt(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
}, (t) => [
  // Unique when present; SQLite permits many NULLs, so un-slugged legacy rows
  // don't collide until `exportSpec` backfills them.
  uniqueIndex('wf_agent_slug_idx').on(t.slug),
])

// Immutable published agent snapshots. `config` is the full AgentConfig JSON
// (model, prompt, toolIds, maxTurns, output contract, sub-agent whitelist). Rows
// written before the legacy `exposeThinking`/`enableReasoning` fields were
// removed still carry them in JSON; zod strips them on read.
export const wfAgentVersion = sqliteTable(
  'wf_agent_version',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    agentId: text('agent_id').notNull(),
    versionNumber: integer('version_number').notNull(),
    config: text('config', { mode: 'json' }).notNull(),
    // The human's own note about what changed (written in the publish dialog).
    changeNote: text('change_note'),
    // The AI's git-style summary of the config diff: a one-line subject
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
    uniqueIndex('wf_agent_version_agent_number_idx').on(
      t.agentId,
      t.versionNumber,
    ),
  ],
)

// 1:1 editable sidecar for an agent. `baseVersionId` records the version the
// draft was forked from.
export const wfAgentDraft = sqliteTable('wf_agent_draft', {
  agentId: text('agent_id').primaryKey(),
  config: text('config', { mode: 'json' }).notNull(),
  baseVersionId: text('base_version_id'),
  lastEditedBy: text('last_edited_by'),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
})
