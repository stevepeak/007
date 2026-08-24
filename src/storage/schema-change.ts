import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { createdAt } from './schema-common'

// ── Change log ───────────────────────────────────────────────────────────
// Append-only: who changed what, when, and to what.
//
// The gap this fills is narrow but load-bearing. Workflows and agents have
// immutable published versions, so their HISTORY is already durable — but a
// draft is one row PK'd on the entity id, overwritten on every save, and entity
// metadata (name, description, icon) has no version at all. Evals have neither:
// `wf_eval_row` holds the actual grading criteria and, until this table, carried
// no actor and no history whatsoever. So when an eval score moved there was no
// way to tell whether the agent changed or the test did.
//
// Shaped after the host's own `audit_event` table on purpose, but it lives HERE,
// in law-wf, next to the rows it describes. The host's table is in law-db, and a
// cross-database write cannot be atomic with the mutation it records.

export const WF_CHANGE_ENTITY_KINDS = [
  'workflow',
  'agent',
  'eval_set',
  'eval_row',
  'model',
  'assignment',
] as const

export type WfChangeEntityKind = (typeof WF_CHANGE_ENTITY_KINDS)[number]

export const WF_CHANGE_ACTIONS = [
  'create',
  'update',
  'publish',
  'archive',
  'restore',
  'assign',
  'enable',
  'disable',
] as const

export type WfChangeAction = (typeof WF_CHANGE_ACTIONS)[number]

/** Where a change came from. The UI is one of several writers. */
export const WF_CHANGE_SOURCES = ['ui', 'spec-import', 'system'] as const

export type WfChangeSource = (typeof WF_CHANGE_SOURCES)[number]

export const wfChange = sqliteTable(
  'wf_change',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    entityKind: text('entity_kind', { enum: WF_CHANGE_ENTITY_KINDS }).notNull(),
    // Opaque pointer, no FK — matches the convention everywhere else in wf_*,
    // and lets a row outlive the thing it describes.
    entityId: text('entity_id').notNull(),
    // Grouping parent: a sample's Goal, so a Goal's activity includes edits to
    // its samples without a second query.
    parentId: text('parent_id'),
    action: text('action', { enum: WF_CHANGE_ACTIONS }).notNull(),
    // Human field labels — ["model", "system prompt"]. The part that makes a row
    // readable, and the part that survives when the payloads are dropped.
    fields: text('fields', { mode: 'json' })
      .notNull()
      .default(sql`'[]'`),
    before: text('before', { mode: 'json' }),
    after: text('after', { mode: 'json' }),
    // Set when a payload was too large to keep. `fields` still stands, so the
    // row stays readable — it just can't be diffed or reverted.
    truncated: integer('truncated', { mode: 'boolean' }).notNull().default(false),
    actorId: text('actor_id'),
    source: text('source', { enum: WF_CHANGE_SOURCES }).notNull().default('ui'),
    // Free-text context — a publish's change note, an import's slug.
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    // Covers both the per-entity activity feed and the coalescing lookup.
    index('wf_change_entity_idx').on(t.entityKind, t.entityId, t.createdAt),
    index('wf_change_parent_idx').on(t.parentId, t.createdAt),
    index('wf_change_actor_idx').on(t.actorId, t.createdAt),
    index('wf_change_created_idx').on(t.createdAt),
  ],
)
