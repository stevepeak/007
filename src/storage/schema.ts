import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

// The SDK owns these tables. Everything is prefixed `wf_` so the schema can
// coexist with any host schema in the same D1 database, and identity is
// OPAQUE: `tenantId` scopes ownership, `subjectId` ties a run to a host entity
// (a chat, a document, …), `correlationId` is a free-form host reference. No
// foreign keys point at host tables — the host maps its own ids into these
// text columns.

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

function createdAt() {
  return integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`)
}

// A workflow — the editable unit a tenant owns. Versions are immutable
// snapshots; the draft is the in-progress sidecar.
export const wfWorkflow = sqliteTable(
  'wf_workflow',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tenantId: text('tenant_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    createdBy: text('created_by'),
    createdAt: createdAt(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }),
  },
  (t) => [index('wf_workflow_tenant_idx').on(t.tenantId)],
)

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
    changeNote: text('change_note'),
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

// A reusable agent — same lifecycle as workflows: the editable unit a
// tenant owns, with immutable published versions and a 1:1 draft sidecar. Name,
// icon, and color are display metadata edited in place; the versioned behavior
// (model, prompt, tools, output contract) lives in `config` on each version.
// Workflow agent nodes reference an agent by `wf_agent.id` and float to its
// latest published version; a run freezes the resolved config in its manifest.
export const wfAgent = sqliteTable(
  'wf_agent',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tenantId: text('tenant_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    // Lucide icon name + a color token — purely for the agent cards.
    icon: text('icon'),
    color: text('color'),
    createdBy: text('created_by'),
    createdAt: createdAt(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }),
  },
  (t) => [index('wf_agent_tenant_idx').on(t.tenantId)],
)

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

// Binds a trigger kind to the workflow that should run for it, per tenant.
export const wfWorkflowAssignment = sqliteTable(
  'wf_workflow_assignment',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tenantId: text('tenant_id').notNull(),
    triggerKind: text('trigger_kind').notNull(),
    workflowId: text('workflow_id').notNull(),
    assignedBy: text('assigned_by'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('wf_assignment_tenant_trigger_idx').on(
      t.tenantId,
      t.triggerKind,
    ),
  ],
)

// One execution.
export const wfRun = sqliteTable(
  'wf_run',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workflowVersionId: text('workflow_version_id').notNull(),
    tenantId: text('tenant_id').notNull(),
    // Opaque host references (no FK).
    subjectId: text('subject_id'),
    correlationId: text('correlation_id'),
    triggerKind: text('trigger_kind').notNull(),
    // Cloudflare Workflows run id — used by RunRoom and to scope writes from
    // concurrent attempts to the right row.
    cloudflareRunId: text('cloudflare_run_id'),
    status: text('status', { enum: WF_RUN_STATUSES })
      .notNull()
      .default('queued'),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),
    error: text('error'),
    output: text('output', { mode: 'json' })
      .notNull()
      .default(sql`'{}'`),
    // Frozen-at-run-start resolution of every floating reference (agents) to
    // the exact published version used, so a run is fully reproducible even as
    // its leaf agents drift. See WfRunManifestEntry.
    manifest: text('manifest', { mode: 'json' })
      .notNull()
      .default(sql`'[]'`),
    createdAt: createdAt(),
  },
  (t) => [
    index('wf_run_tenant_created_idx').on(t.tenantId, t.createdAt),
    index('wf_run_version_created_idx').on(t.workflowVersionId, t.createdAt),
    index('wf_run_subject_idx').on(t.subjectId),
  ],
)

// Ordered execution trace — one row per node fired. `node_id` is the stable
// UUID from the graph (joined back to the version's graph JSON for display).
// The unique (run_id, node_id) constraint is what makes the durable recorder's
// upsert idempotent across `step.do` retries.
export const wfRunStep = sqliteTable(
  'wf_run_step',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    runId: text('run_id').notNull(),
    nodeId: text('node_id').notNull(),
    nodeKind: text('node_kind').notNull(),
    sequence: integer('sequence').notNull(),
    status: text('status', { enum: WF_RUN_STEP_STATUSES }).notNull(),
    input: text('input', { mode: 'json' })
      .notNull()
      .default(sql`'{}'`),
    output: text('output', { mode: 'json' })
      .notNull()
      .default(sql`'{}'`),
    branchResult: text('branch_result', { mode: 'json' }),
    meta: text('meta', { mode: 'json' })
      .notNull()
      .default(sql`'{}'`),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),
    error: text('error'),
  },
  (t) => [
    index('wf_run_step_run_sequence_idx').on(t.runId, t.sequence),
    uniqueIndex('wf_run_step_run_node_idx').on(t.runId, t.nodeId),
  ],
)

export const wfSchema = {
  wfWorkflow,
  wfWorkflowVersion,
  wfWorkflowDraft,
  wfAgent,
  wfAgentVersion,
  wfAgentDraft,
  wfWorkflowAssignment,
  wfRun,
  wfRunStep,
}
