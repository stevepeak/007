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

// One case ("Sample"): the INPUT the target is invoked with, how its TOOLS
// behave for this case, and the AND/OR check tree. Shapes are validated by
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
    // A tagged input variant matching the target's own contract — see
    // EvalSampleInput ({ kind: 'task' | 'conversation' | 'trigger', … }). Rows
    // written before the split hold the legacy `{ triggerInput,
    // promptVariables, seededMessages, freezeTools }` shape and are upgraded on
    // read by `parseEvalSampleInput`.
    // Default stays the bare `'{}'` this column was created with: an empty
    // object is a legacy shape, and `parseEvalSampleInput` reads it as an empty
    // `task` input. Keeping it avoids a SQLite table rebuild for a default that
    // no insert path ever relies on.
    input: text('input', { mode: 'json' })
      .notNull()
      .default(sql`'{}'`),
    // How the target's tools behave for this sample — see EvalTools ({ mode:
    // 'live' | 'mocked' | 'frozen' }). Legacy rows hold a bare fixtures record
    // here; `parseEvalTools` folds it (plus the legacy freeze flag, which lived
    // on the other column) into a mode.
    tools: text('tools', { mode: 'json' })
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
    // The frozen sweep manifest — every (sample x model x prompt x attempt)
    // cell this run was launched to produce, plus the draft config and
    // concurrency it was launched with. See `EvalPlan`.
    //
    // This column is what makes an eval run RESUMABLE. Before it, the cell list
    // existed only as a local array in whichever process called `runEval`, so
    // the row was a counter rather than a plan: nothing else could tell what
    // was left to do. A browser tab closing or an MCP request ending therefore
    // stranded the sweep permanently, with no way for anything to pick it up.
    // NULL for runs created before this column existed — those are not
    // resumable and the backstop skips them.
    plan: text('plan', { mode: 'json' }),
    // Mutable driver state: which cells are in flight (with the `wf_run` each
    // one started) and the circuit breaker's tally. Held here rather than in
    // the driver's memory for the same reason as `plan` — a cell already
    // started must not be started again by whoever picks the sweep up next.
    driveState: text('drive_state', { mode: 'json' }),
    // Last time a driver made progress on this run. The backstop adopts a run
    // only once this goes stale, which is what keeps it from stealing cells
    // from a browser tab that is actively driving the same sweep.
    heartbeatAt: integer('heartbeat_at', { mode: 'timestamp' }),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),
    createdBy: text('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    index('wf_eval_run_created_idx').on(t.createdAt),
    // The backstop's only query: unfinished runs, oldest heartbeat first.
    index('wf_eval_run_heartbeat_idx').on(t.status, t.heartbeatAt),
  ],
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
    // The row's judge PASS RATE; null when the row has no judge check.
    score: real('score'),
    // Per-check verdicts: [{ pass, confidence?, reason? }] — see CheckResult.
    checkResults: text('check_results', { mode: 'json' })
      .notNull()
      .default(sql`'[]'`),
    // Why this cell has no verdict. Set only for `status: 'error'` — the run
    // failed, was cancelled, or never reached a terminal state before the
    // orchestrator stopped waiting. Null for pass/fail, where `checkResults`
    // already explains the outcome. Without this a failed cell used to write no
    // row at all, so an eval whose provider was down reported "0 results" and
    // gave the user nothing to act on.
    error: text('error'),
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
