import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

import {
  createdAt,
  WF_EVAL_RESULT_STATUSES,
  WF_EVAL_TARGET_KINDS,
  WF_RUN_STATUSES,
} from './schema-common'

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
    // ── Matrix cell identity ─────────────────────────────────────────────────
    // Which (model × prompt × attempt) cell of a matrix run produced this result.
    // All nullable: a non-matrix run (the target's own saved model/prompt, single
    // attempt) leaves them null and the report collapses those into one baseline
    // cell. `modelId` is the composite catalog id (providerId:modelId) the cell
    // ran; `promptBody` null means the baseline (agent's saved prompt). Cost /
    // tokens / duration are NOT stored here — they're derived live per result via
    // `loadRunStats` (the run's agent steps are the single source of truth).
    modelId: text('model_id'),
    promptLabel: text('prompt_label'),
    promptBody: text('prompt_body'),
    attempt: integer('attempt'),
    createdAt: createdAt(),
  },
  (t) => [
    index('wf_eval_result_run_idx').on(t.evalRunId),
    index('wf_eval_result_row_idx').on(t.rowId),
    index('wf_eval_result_cell_idx').on(t.evalRunId, t.modelId, t.promptLabel),
  ],
)
