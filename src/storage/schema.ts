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
    // Stable 32-hex trace id minted at run start. Every per-node Sentry span is
    // seeded with it so the run groups into one distributed trace; the run
    // viewer builds a "View trace in Sentry" deep-link from it. Null for runs
    // started before tracing was wired.
    sentryTraceId: text('sentry_trace_id'),
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

// Structured progress feed — the human-readable, run-controlled log stream shown
// in the run viewer's Logs panel and streamed live over the RunRoom → SSE
// channel. One row per emitted entry (a node entered/finished, a line we chose
// to print, an agent's internal reasoning, a tool call). Distinct from
// `wf_run_step` (one row per node, the machine trace): this is the narrative.
// `ts` is the engine-stamped emit time (millis) and drives ordering, since many
// entries share a node and a monotonic wall-clock is a stabler sort than a
// row's write time. No unique key — entries are append-only, replaced wholesale
// per-node on the (idempotent) record step, so a retried step can't duplicate.
export const wfRunLog = sqliteTable(
  'wf_run_log',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    runId: text('run_id').notNull(),
    nodeId: text('node_id'),
    nodeKind: text('node_kind'),
    sequence: integer('sequence'),
    level: text('level').notNull(),
    message: text('message').notNull(),
    meta: text('meta', { mode: 'json' }),
    // Engine emit time (epoch millis). Primary sort for the feed.
    ts: integer('ts').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('wf_run_log_run_ts_idx').on(t.runId, t.ts),
    index('wf_run_log_run_node_idx').on(t.runId, t.nodeId),
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
    // Which published version of the target the goal pins to. NULL floats to the
    // latest published version (the default); a number pins to that exact
    // version so the goal keeps grading against a frozen target.
    targetVersion: integer('target_version'),
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
    // Frozen copy of the Sample + Goal target this result was produced and graded
    // against — see EvalRowSnapshot. Makes a historical result reproducible even
    // after its Sample/checks are edited (the report reads this, not the live
    // row). NULL only for results written before this column existed. The
    // concrete agent version that ran stays reachable via `wfRunId` → the real
    // wf_run's frozen `manifest`, so it isn't duplicated here.
    snapshot: text('snapshot', { mode: 'json' }),
    // sha256 over the snapshot's reproducibility-relevant fields (sample inputs +
    // checks + goal target identity). Lets two runs of the same Sample be
    // compared ("did the definition change?") and identical snapshots deduped,
    // without reintroducing a version counter on Samples/Tests.
    snapshotHash: text('snapshot_hash'),
    createdAt: createdAt(),
  },
  (t) => [
    index('wf_eval_result_run_idx').on(t.evalRunId),
    index('wf_eval_result_row_idx').on(t.rowId),
  ],
)

// A model provider the platform can pull a catalog from (OpenRouter today;
// Venice/others later). Providers are a single GLOBAL set — the enabled catalog
// is platform-wide config, not tenant-scoped. `lastRefreshedAt` records the last
// successful pull from this provider's `/models` endpoint. No FK; `id` is an
// opaque host-chosen key (e.g. 'openrouter') matching the host's provider
// registry. Credentials live in the host env, never here.
export const wfModelProvider = sqliteTable('wf_model_provider', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  // Mirrors engine `ModelProviderKind`: openrouter | openai | openai-compatible
  // | custom. Free text (not an enum) so the host can introduce kinds without a
  // migration.
  kind: text('kind').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  note: text('note'),
  lastRefreshedAt: integer('last_refreshed_at', { mode: 'timestamp' }),
  createdAt: createdAt(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
})

// One cached model from a provider's catalog. `id` is the COMPOSITE
// `providerId:modelId` (two providers may expose the same bare id), while
// `modelId` keeps the provider-native id passed to the host's `getModel`.
// `enabled` is the platform's opt-in: refresh inserts new models disabled and
// preserves the flag on existing ones, so the user curates which models the
// pickers may use. Prices are USD per 1M tokens; `tokensPerSec` and the price
// fields are nullable when the provider doesn't report them. `raw` keeps the
// untouched catalog entry for future fields. No FK to the provider row.
export const wfModel = sqliteTable(
  'wf_model',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id').notNull(),
    modelId: text('model_id').notNull(),
    label: text('label').notNull(),
    // Grouping/filter key: the vendor prefix (before '/') for OpenRouter ids,
    // else the provider label.
    vendor: text('vendor'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
    // Blended USD/1M tokens used by the existing pickers' cost display.
    costPerMTok: real('cost_per_m_tok'),
    promptPricePerMTok: real('prompt_price_per_m_tok'),
    completionPricePerMTok: real('completion_price_per_m_tok'),
    contextLength: integer('context_length'),
    tokensPerSec: real('tokens_per_sec'),
    raw: text('raw', { mode: 'json' }),
    createdAt: createdAt(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }),
  },
  (t) => [
    index('wf_model_provider_idx').on(t.providerId),
    index('wf_model_enabled_idx').on(t.enabled),
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
  wfModelProvider,
  wfModel,
}
