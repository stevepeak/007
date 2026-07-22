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
})

// Immutable published agent snapshots. `config` is the full AgentConfig JSON
// (model, prompt, toolIds, maxTurns, exposeThinking, output contract).
export const wfAgentVersion = sqliteTable(
  'wf_agent_version',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    agentId: text('agent_id').notNull(),
    versionNumber: integer('version_number').notNull(),
    config: text('config', { mode: 'json' }).notNull(),
    changeNote: text('change_note'),
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
