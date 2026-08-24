import type {
  CheckResult,
  CheckTree,
  EvalRowSnapshot,
  EvalSampleInput,
  EvalTools,
} from '../eval/checks'

// ── Evals ─────────────────────────────────────────────────────────────────
// The UI vocabulary is Goal / Sample / Test; the wire keeps the code identifiers
// set / row / check. The check tree, input, and tools shapes are the pure
// zod-inferred types shared with the grader and the `bun:test` harness.
export type {
  CheckResult,
  CheckTree,
  EvalCheck,
  EvalCheckType,
  EvalFixtures,
  EvalMatch,
  EvalRowSnapshot,
  EvalSampleInput,
  EvalSampleInputKind,
  EvalSampleLayer,
  EvalToolMode,
  EvalTools,
  SeededMessage,
  SeededToolCall,
} from '../eval/checks'
// Runtime re-exports of the lightweight (zod-only) eval vocabulary so UI pickers
// derive their options from the schema instead of re-hardcoding it. `checks.ts`
// pulls in only zod, so this stays safe for the browser bundle.
export {
  BINARY_CHECK_TYPES,
  EVAL_CHECK_TYPES,
  evalMatchSchema,
  evalSampleLayer,
  JUDGE_CONFIDENCE_MAX,
  toolFixtures,
  unavailableCheckTypes,
} from '../eval/checks'

// Wire enums for eval targets/verdicts, derived from the DB-schema `as const`
// arrays (their canonical home) so the wire and storage vocabularies can't
// drift. `import type` keeps this erased — no drizzle in the UI bundle.
import type {
  WF_EVAL_RESULT_STATUSES,
  WF_EVAL_TARGET_KINDS,
} from '../storage/schema'

/** What an eval set targets — an agent or a workflow, resolved float-to-latest. */
export type WfEvalTargetKind = (typeof WF_EVAL_TARGET_KINDS)[number]
/** A row's verdict after grading its run's trace. */
export type WfEvalResultStatus = (typeof WF_EVAL_RESULT_STATUSES)[number]

// A "Goal" — a named set of samples run against one target (agent/workflow).
export type WfEvalSetSummary = {
  id: string
  name: string
  description: string | null
  targetKind: WfEvalTargetKind
  /** Opaque pointer to a wf_agent.id / wf_workflow.id (no FK). */
  targetId: string
  /** Version pin for the target: null floats to the latest published version. */
  targetVersion: number | null
  /** The trigger kind the target is invoked under. */
  triggerKind: string
  archived: boolean
  /** Non-archived rows in the set. */
  rowCount: number
  createdAt: number
  updatedAt: number | null
}

// A "Sample" — one test case: the INPUT the target is invoked with (shaped like
// the target's own contract), how its TOOLS behave for this case, and the check
// tree that grades the resulting run.
export type WfEvalRowDTO = {
  id: string
  setId: string
  name: string
  description: string | null
  input: EvalSampleInput
  tools: EvalTools
  checks: CheckTree
  sortOrder: number
  archived: boolean
}

export type WfEvalSetDetail = {
  set: WfEvalSetSummary
  rows: WfEvalRowDTO[]
}

// One execution of one or more sets — the umbrella over the per-row results.
export type WfEvalRunSummary = {
  id: string
  status: string
  /** The sets included in this run. */
  setIds: string[]
  total: number
  passed: number
  failed: number
  /** Mean score across scored (judge-bearing) rows; null when none. */
  score: number | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

// Cost / speed / model of the AGENT CALL a result graded — scoped to the agent
// steps only, never the judge/test grading that runs afterward. `models` are
// the provider-native ids of those agent steps; `durationMs` is their own
// wall-clock (see {@link RunStats}).
export type WfEvalResultRunStats = {
  totalTokens: number | null
  costUsd: number | null
  models: string[]
  durationMs: number | null
  /**
   * The agent version this result actually ran — the second drift axis, and the
   * one `previousSnapshotHash` structurally cannot see. A Goal that floats to
   * the latest published version (the default) keeps an IDENTICAL hash when the
   * agent is republished, so without this a report shows "nothing changed" for
   * two runs of two different agents.
   */
  agentVersion: number | null
}

// One row's outcome within an eval run: the verdict, the judge score, the
// per-check breakdown, and a link to the real `wf_run` it graded.
export type WfEvalResultDTO = {
  id: string
  evalRunId: string
  rowId: string
  /** The `wf_run` produced for this row (null until it starts). */
  wfRunId: string | null
  /**
   * Cost / speed / model of the `wf_run` this row graded — for an agent-target
   * eval, the agent call itself. Derived live from the run + its agent steps;
   * null when the run hasn't produced stats (or predates the wfRun link).
   */
  runStats: WfEvalResultRunStats | null
  status: WfEvalResultStatus
  score: number | null
  checkResults: CheckResult[]
  /**
   * Why an `error` result has no verdict — the run failed, was cancelled, or
   * never finished before the orchestrator stopped waiting. Null for pass/fail,
   * where `checkResults` carries the explanation. This is the only place the
   * report can tell a user that a zero pass rate was infrastructure, not their
   * agent.
   */
  error: string | null
  /**
   * Frozen Sample + Goal target this result ran + was graded against. The report
   * reads this (not the live Sample) so editing a Sample later doesn't rewrite
   * how a past run displays. Null only for results graded before snapshots
   * existed — consumers fall back to the live row.
   */
  snapshot: EvalRowSnapshot | null
  /** sha256 of `snapshot`'s reproducibility-relevant fields; null when no snapshot. */
  snapshotHash: string | null
  /**
   * The hash this SAMPLE carried the last time it ran before this run — the
   * baseline for "was the test edited since?". Null when the sample is new, or
   * when either side predates snapshots.
   *
   * Note what this can and cannot see. It compares the sample's DEFINITION, so
   * it catches an edited check or input. It does NOT catch the target agent
   * being republished under a floating `targetVersion`, which leaves the hash
   * identical — that axis is reported separately.
   */
  previousSnapshotHash: string | null
  /**
   * Matrix cell this result belongs to — which (model × prompt × attempt) of the
   * run's model×prompt sweep produced it. All null for a plain run (the target's
   * own saved model/prompt); the report then collapses them into one baseline
   * cell. `modelId` is the composite catalog id; `promptLabel` names the prompt
   * variation (e.g. "Agent's saved prompt" / "Test prompt 1").
   */
  modelId: string | null
  promptLabel: string | null
  promptBody: string | null
  attempt: number | null
  createdAt: number
}

/** One recorded edit, as the drift banner names it. */
export type WfEvalDriftChange = {
  entityKind: 'agent' | 'workflow' | 'eval_set' | 'eval_row'
  action: string
  /** Human field labels — "checks", "system prompt". */
  fields: string[]
  actorId: string | null
  note: string | null
  at: number
}

/**
 * Everything needed to answer "what changed since the last comparable run?" —
 * the question a moved pass rate always raises and a report could never answer.
 *
 * `previousRun` is derived from the SAMPLES, not the run list: runs cover
 * whatever Goals were asked for, so the run before this one in time may share no
 * samples with it.
 */
export type WfEvalRunDrift = {
  previousRunId: string
  previousRunAt: number
  /** The agent version that run executed, when it recorded one. */
  previousAgentVersion: number | null
  /** Edits to the Goal and its samples between the two runs. */
  goalChanges: WfEvalDriftChange[]
  /** Edits to the agent (or workflow) under test between the two runs. */
  targetChanges: WfEvalDriftChange[]
}

export type WfEvalRunDetail = {
  run: WfEvalRunSummary
  results: WfEvalResultDTO[]
  /** Null when no earlier run covered any of these samples. */
  drift: WfEvalRunDrift | null
}
