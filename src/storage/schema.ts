import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

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

function createdAt() {
  return integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`)
}

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

// One execution.
export const wfRun = sqliteTable(
  'wf_run',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workflowVersionId: text('workflow_version_id').notNull(),
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
    // Marks a run produced by an eval (simulate=true). Since there is no tenant
    // partition, this flag is how the general Runs explorer keeps eval runs out
    // of a firm's view (default listings exclude it). See wf_eval_result.wfRunId.
    isEval: integer('is_eval', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index('wf_run_created_idx').on(t.createdAt),
    index('wf_run_version_created_idx').on(t.workflowVersionId, t.createdAt),
    index('wf_run_subject_idx').on(t.subjectId),
    index('wf_run_eval_created_idx').on(t.isEval, t.createdAt),
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

// ── Evals ────────────────────────────────────────────────────────────────
// An eval suite ("Goal" in the UI): one target (agent OR workflow, float-to-
// latest) plus N rows. Part of the same global set — no tenant column; access
// is host-gatekept like everything else.
export const wfEvalSet = sqliteTable(
  'wf_eval_set',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text('name').notNull(),
    description: text('description'),
    targetKind: text('target_kind', { enum: WF_EVAL_TARGET_KINDS }).notNull(),
    // Opaque pointer to a wf_agent.id or wf_workflow.id (resolved float-to-
    // latest at run start). No FK — mirrors the run-identity convention.
    targetId: text('target_id').notNull(),
    // The trigger kind the target is invoked under (drives row initialCondition).
    triggerKind: text('trigger_kind').notNull(),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    createdBy: text('created_by'),
    createdAt: createdAt(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }),
  },
  (t) => [index('wf_eval_set_created_idx').on(t.createdAt)],
)

// One case ("Sample"): an initial condition, the canned fixtures reads return
// under simulate, and the AND/OR check tree. Shapes are validated by
// `src/eval/checks.ts` at the data-access boundary.
export const wfEvalRow = sqliteTable(
  'wf_eval_row',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    setId: text('set_id').notNull(),
    name: text('name').notNull(),
    // Optional free-text description of the sample, authored by the user.
    description: text('description'),
    // { triggerInput, promptVariables } — see EvalInitialCondition.
    initialCondition: text('initial_condition', { mode: 'json' })
      .notNull()
      .default(sql`'{}'`),
    // Canned tool outputs keyed by toolId — see EvalFixtures.
    fixtures: text('fixtures', { mode: 'json' })
      .notNull()
      .default(sql`'{}'`),
    // { op, checks[] } — see CheckTree.
    checks: text('checks', { mode: 'json' })
      .notNull()
      .default(sql`'{"op":"and","checks":[]}'`),
    sortOrder: integer('sort_order').notNull().default(0),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }),
  },
  (t) => [index('wf_eval_row_set_order_idx').on(t.setId, t.sortOrder)],
)

// One "test run" execution across ≥1 sets. Counts + mean score roll up from the
// per-row results as they finish.
export const wfEvalRun = sqliteTable(
  'wf_eval_run',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    status: text('status', { enum: WF_RUN_STATUSES }).notNull().default('queued'),
    // JSON array of the set ids included in this run.
    setIds: text('set_ids', { mode: 'json' })
      .notNull()
      .default(sql`'[]'`),
    total: integer('total').notNull().default(0),
    passed: integer('passed').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    // Overall mean score across scored (judge-bearing) rows; null when none.
    score: real('score'),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),
    createdBy: text('created_by'),
    createdAt: createdAt(),
  },
  (t) => [index('wf_eval_run_created_idx').on(t.createdAt)],
)

// One row's outcome inside an eval run. `wfRunId` links to the REAL wf_run the
// eval produced — the single trace both the RunViewer and the grader read.
export const wfEvalResult = sqliteTable(
  'wf_eval_result',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    evalRunId: text('eval_run_id').notNull(),
    rowId: text('row_id').notNull(),
    // The wf_run produced for this row (null until the run is started).
    wfRunId: text('wf_run_id'),
    status: text('status', { enum: WF_EVAL_RESULT_STATUSES }).notNull(),
    // Weighted mean of the row's judge scores; null when the row has none.
    score: real('score'),
    // Per-check verdicts: [{ pass, score?, reason? }] — see CheckResult.
    checkResults: text('check_results', { mode: 'json' })
      .notNull()
      .default(sql`'[]'`),
    createdAt: createdAt(),
  },
  (t) => [
    index('wf_eval_result_run_idx').on(t.evalRunId),
    index('wf_eval_result_row_idx').on(t.rowId),
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
  wfEvalSet,
  wfEvalRow,
  wfEvalRun,
  wfEvalResult,
}
