import { z } from 'zod'

// The eval check vocabulary — the shared shape of a row's stored `checks` tree,
// its `initialCondition`, its `fixtures`, and a graded `checkResult`. This
// module is the single source of truth for BOTH the storage/data layer (which
// validates the JSON it persists) and the Phase 3 grading engine (`grade.ts`,
// which evaluates each check against a run trace). Only the *shapes* live here;
// the evaluators are in `grade.ts`.

/** How a value check compares expected vs. actual. Not every check uses all. */
export const evalMatchSchema = z.enum([
  'equals',
  'contains',
  'jsonpath',
  'regex',
])
export type EvalMatch = z.infer<typeof evalMatchSchema>

// Common, presentation-only metadata carried by every check. Authored in the
// Test editor; ignored by the grader. Kept optional so pre-existing checks (and
// the bun:test harness) validate without them.
const checkMeta = {
  /** User-facing title; when absent the UI derives one from the assertion. */
  label: z.string().optional(),
  /** Longer free-text explanation of what this check asserts. */
  description: z.string().optional(),
}

// ── Judge verdicts ──────────────────────────────────────────────────────────
// An LLM judge returns one of THREE anchored verdicts, never a free float. A
// model asked for "a score from 0 to 1" produces numbers it cannot defend —
// 0.72 vs 0.68 is noise, and two runs of the same output drift by more than the
// cutoff separating pass from fail. Three buckets with written anchors is a
// judgment a model can actually make repeatably, and one an author can read.

export const judgeVerdictSchema = z.enum(['strong', 'partial', 'weak'])
export type JudgeVerdict = z.infer<typeof judgeVerdictSchema>

/** What each verdict contributes to the row's 0..1 quality score. */
export const JUDGE_VERDICT_SCORE: Record<JudgeVerdict, number> = {
  strong: 1,
  partial: 0.5,
  weak: 0,
}

/**
 * How good the verdict has to be for the check to pass. `score_only` never
 * fails a sample — the verdict still feeds the quality score, which is how you
 * track a soft quality bar (tone, concision) without it gating the suite.
 */
export const judgeBarSchema = z.enum(['nails_it', 'close_enough', 'score_only'])
export type JudgeBar = z.infer<typeof judgeBarSchema>

/** The verdicts that clear each bar. */
const BAR_PASSING_VERDICTS: Record<JudgeBar, readonly JudgeVerdict[]> = {
  nails_it: ['strong'],
  close_enough: ['strong', 'partial'],
  score_only: ['strong', 'partial', 'weak'],
}

export function judgeVerdictPasses(bar: JudgeBar, verdict: JudgeVerdict): boolean {
  return BAR_PASSING_VERDICTS[bar].includes(verdict)
}

/**
 * The bar a judge check grades against. Prefers the authored `bar`; falls back
 * to the LEGACY `threshold` by INTENT rather than arithmetic — the old default
 * of 0.7 was documented as "clearly good, minor flaws OK", which is
 * `close_enough`, even though 0.7 would mechanically reject a `partial` (0.5).
 * Mapping it arithmetically would silently make every saved check stricter.
 */
export function resolveJudgeBar(check: { bar?: JudgeBar; threshold?: number }): JudgeBar {
  if (check.bar) return check.bar
  if (check.threshold == null) return 'close_enough'
  if (check.threshold <= 0) return 'score_only'
  return check.threshold > 0.8 ? 'nails_it' : 'close_enough'
}

// A single assertion. Two families, split by how they produce a verdict:
//   • binary/deterministic — pass|fail read straight off the run trace.
//   • subjective/scored    — an LLM judge returns pass|fail AND a 0..1 score.
export const evalCheckSchema = z.discriminatedUnion('type', [
  // ── binary / deterministic ────────────────────────────────────────────────
  z.object({
    ...checkMeta,
    type: z.literal('tool_called'),
    toolId: z.string(),
    /** Assert the tool WAS (true) or was NOT (false) called during the run. */
    called: z.boolean(),
  }),
  z.object({
    ...checkMeta,
    type: z.literal('tool_args_match'),
    toolId: z.string(),
    /** Optional JSON path into the recorded `meta.args`; omit = whole object. */
    path: z.string().optional(),
    match: evalMatchSchema,
    value: z.unknown(),
  }),
  z.object({
    ...checkMeta,
    type: z.literal('node_visited'),
    nodeId: z.string(),
    visited: z.boolean(),
  }),
  z.object({
    ...checkMeta,
    type: z.literal('node_input_match'),
    nodeId: z.string(),
    /** Optional JSON path into the node's recorded `input`; omit = whole. */
    path: z.string().optional(),
    match: evalMatchSchema,
    value: z.unknown(),
  }),
  z.object({
    ...checkMeta,
    type: z.literal('output_match'),
    /** Optional JSON path into the run `output`; omit = whole object. */
    path: z.string().optional(),
    match: evalMatchSchema,
    value: z.unknown(),
  }),
  // ── subjective / scored ───────────────────────────────────────────────────
  z.object({
    ...checkMeta,
    type: z.literal('llm_judge'),
    rubric: z.string(),
    /**
     * Optional JSON path into the run `output`. When set, the judge grades ONLY
     * the value at that path (e.g. `docMeta.parties`) instead of the whole
     * output — a way to point the rubric at one known field. Omit = whole output.
     */
    path: z.string().optional(),
    /** Judge model; falls back to a suite/run default when omitted. */
    modelId: z.string().optional(),
    /** How good the judge's verdict must be to pass. Default `close_enough`. */
    bar: judgeBarSchema.optional(),
    /**
     * LEGACY 0..1 cutoff from when the judge returned a free float. Superseded
     * by {@link judgeBarSchema}; still read by {@link resolveJudgeBar} so saved
     * checks keep grading the way their author meant. Never written anymore.
     */
    threshold: z.number().min(0).max(1).optional(),
    /**
     * LEGACY relative weight of this judge's score in the row's mean. Still
     * honored by the grader for saved checks, but no longer authorable: a
     * weighted mean of judge scores was a knob nobody could predict the effect
     * of. Add or drop a check instead of re-weighting one.
     */
    weight: z.number().min(0).optional(),
  }),
])
export type EvalCheck = z.infer<typeof evalCheckSchema>

/** A check `type` discriminator id. */
export type EvalCheckType = EvalCheck['type']

/**
 * Every check `type` id, derived from the discriminated union in declaration
 * order — the single source the UI pickers derive from so a new check kind can't
 * be forgotten in the editor.
 */
export const EVAL_CHECK_TYPES: EvalCheckType[] = evalCheckSchema.options.map(
  (o) => o.shape.type.value,
)

/**
 * The deterministic (non-judge) check type ids — graded straight off the run
 * trace. Everything except `llm_judge`.
 */
export const BINARY_CHECK_TYPES = EVAL_CHECK_TYPES.filter(
  (t): t is Exclude<EvalCheckType, 'llm_judge'> => t !== 'llm_judge',
)

/** The AND/OR reducer over a row's checks. */
export const checkTreeSchema = z.object({
  op: z.enum(['and', 'or']),
  checks: z.array(evalCheckSchema),
})
export type CheckTree = z.infer<typeof checkTreeSchema>

// ── Synthesis mode (seeded conversation) ────────────────────────────────────
// One tool interaction folded into a seeded assistant turn: the call the
// assistant "made" and the result it "saw". Both `args` and `output` are
// optional so an author can stage just a retrieved-context blob without
// hand-writing the query the model would have generated.
export const seededToolCallSchema = z.object({
  /** Registry tool id the assistant is treated as having called (e.g. `search_rag`). */
  tool: z.string(),
  /** The arguments the assistant called it with. Omit → `{}`. */
  args: z.unknown().optional(),
  /** The canned result the tool returned into the conversation. Omit → `{}`. */
  output: z.unknown().optional(),
})
export type SeededToolCall = z.infer<typeof seededToolCallSchema>

/**
 * One turn of a seeded conversation. A `user` turn carries text; an `assistant`
 * turn carries text and/or tool calls (each with its canned result) — letting an
 * author stage "the assistant already searched and got these chunks" so the run
 * begins mid-conversation and only the model's NEXT (final) reply is produced.
 */
export const seededMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string().optional(),
  toolCalls: z.array(seededToolCallSchema).optional(),
})
export type SeededMessage = z.infer<typeof seededMessageSchema>

// ── A Sample's INPUT ────────────────────────────────────────────────────────
// What the target is invoked with — one variant per shape of target, mirroring
// the target's OWN input contract (`AgentConfig.inputKind`) rather than offering
// every field to every sample. A task agent is graded on input → output; a
// conversation agent is graded on the reply it produces next, given a thread.
// Exactly one variant applies to a given Sample, so the editor never renders two
// competing input sources and the runner never has to guess which one wins.

/** A Sample's input for a `task` agent — the values its `${vars}` resolve to. */
export const taskInputSchema = z.object({
  kind: z.literal('task'),
  /** Values for the target's declared prompt variables, keyed by name. */
  variables: z.record(z.string(), z.string()).default({}),
})

/**
 * A Sample's input for a `conversation` agent — the thread it answers. `turns`
 * become the agent's message history, so the run begins mid-conversation and
 * only the model's NEXT (final) reply is produced. A conversation agent's system
 * prompt can still interpolate `${vars}`, so `variables` rides along.
 */
export const conversationInputSchema = z.object({
  kind: z.literal('conversation'),
  turns: z.array(seededMessageSchema).default([]),
  variables: z.record(z.string(), z.string()).default({}),
})

/**
 * A Sample's input for a WORKFLOW target — the raw trigger payload, verbatim.
 * A workflow has no single prompt to fill in; what it receives is whatever its
 * trigger routed, so the Sample preserves that object as-is.
 */
export const triggerInputSchema = z.object({
  kind: z.literal('trigger'),
  payload: z.record(z.string(), z.unknown()).default({}),
  /** Run-level prompt variables, for agents nested inside the workflow. */
  variables: z.record(z.string(), z.string()).default({}),
})

export const evalSampleInputSchema = z.discriminatedUnion('kind', [
  taskInputSchema,
  conversationInputSchema,
  triggerInputSchema,
])
export type EvalSampleInput = z.infer<typeof evalSampleInputSchema>
export type EvalSampleInputKind = EvalSampleInput['kind']

/** Canned tool outputs keyed by tool id, consumed by read tools under simulate. */
export const evalFixturesSchema = z.record(z.string(), z.unknown())
export type EvalFixtures = z.infer<typeof evalFixturesSchema>

// ── A Sample's TOOLS ────────────────────────────────────────────────────────
// How the target's tools behave for this Sample. One tri-state, because the
// three settings are mutually exclusive in the engine and were previously
// authorable as contradictory combinations: `freezeTools` (an empty tool set)
// silently made every fixture below it dead, and every trajectory check
// ungradeable, with nothing in the UI saying so.
//
// Write tools are neutralized in ALL three modes — an eval never writes.

export const evalToolsSchema = z.discriminatedUnion('mode', [
  /**
   * Read tools execute for real. The integration layer: grades the agent
   * against live retrieval, so a bad query or an empty corpus shows up as a
   * failure instead of being papered over by a fixture.
   */
  z.object({ mode: z.literal('live') }),
  /**
   * Read tools return their canned `fixtures` entry (a tool with no entry
   * returns `{}`). The trajectory layer: deterministic, side-effect free, and
   * the only mode where `tool_called` / `tool_args_match` mean anything.
   */
  z.object({ mode: z.literal('mocked'), fixtures: evalFixturesSchema.default({}) }),
  /**
   * The agent runs with NO tools and must answer from its input alone. The
   * synthesis layer: isolates response quality from retrieval / tool-selection
   * nondeterminism. Pair with a `conversation` input that already stages the
   * retrieved context as an assistant turn's tool result.
   */
  z.object({ mode: z.literal('frozen') }),
])
export type EvalTools = z.infer<typeof evalToolsSchema>
export type EvalToolMode = EvalTools['mode']

/** The canned outputs this tool setting supplies — empty outside `mocked`. */
export function toolFixtures(tools: EvalTools): EvalFixtures {
  return tools.mode === 'mocked' ? tools.fixtures : {}
}

// ── Derived: what kind of test is this? ─────────────────────────────────────
// The testing LAYER a Sample belongs to is a function of its input and its
// tools, never a stored field — so it can't drift from the settings it names.
// See the three layers in `docs`: trajectory, synthesis, integration.

export type EvalSampleLayer =
  | 'io'
  | 'trajectory'
  | 'synthesis'
  | 'integration'

export function evalSampleLayer(
  input: EvalSampleInput,
  tools: EvalTools,
): EvalSampleLayer {
  // Synthesis needs BOTH halves: staged context to answer from, and no tools to
  // go get more. Freezing a task agent's (nonexistent) tools isn't synthesis —
  // it's the plain input → output test it already was.
  if (tools.mode === 'frozen') {
    return input.kind === 'conversation' ? 'synthesis' : 'io'
  }
  if (tools.mode === 'live') return 'integration'
  // Mocked tools with something actually mocked = a trajectory test; mocked
  // with nothing mocked is just an input → output test.
  return Object.keys(toolFixtures(tools)).length > 0 ? 'trajectory' : 'io'
}

/**
 * Check types that cannot produce a meaningful verdict under a tool setting.
 * Under `frozen` the agent calls nothing, so the trace has no tool step and a
 * trajectory check grades an absence — which is a false failure, not a signal.
 */
export function unavailableCheckTypes(tools: EvalTools): EvalCheckType[] {
  return tools.mode === 'frozen' ? ['tool_called', 'tool_args_match'] : []
}

// ── Legacy row upgrade ──────────────────────────────────────────────────────
// Samples authored before the Input/Tools split stored `{ triggerInput,
// promptVariables, seededMessages, freezeTools }` in one column and a bare
// fixtures record in another. The two columns were renamed in place (migration
// `wf_eval_row` → `input` / `tools`) rather than rewritten with JSON surgery in
// SQL, so the upgrade happens HERE, at the single read boundary, and the new
// shape is what gets written back on the next save.
//
// This mirrors `migrateLegacyAgentConfig` — same reason: one normalizing parse
// beats a shim at every consumer.

type LegacyInitialCondition = {
  triggerInput?: Record<string, unknown>
  promptVariables?: Record<string, string>
  seededMessages?: SeededMessage[]
  freezeTools?: boolean
}

function isLegacyInput(value: unknown): value is LegacyInitialCondition {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !('kind' in value)
  )
}

/**
 * Parse a row's stored `input` column, upgrading the legacy initial-condition
 * shape on the way through. A legacy row becomes a `conversation` input when it
 * seeded turns, a `trigger` input when it carried only a routed payload, and a
 * `task` input otherwise — which is what every agent-target Sample authored so
 * far actually is.
 */
export function parseEvalSampleInput(value: unknown): EvalSampleInput {
  if (isLegacyInput(value)) {
    const legacy = value
    const variables = legacy.promptVariables ?? {}
    if (legacy.seededMessages && legacy.seededMessages.length > 0) {
      return { kind: 'conversation', turns: legacy.seededMessages, variables }
    }
    const payload = legacy.triggerInput ?? {}
    if (Object.keys(variables).length === 0 && Object.keys(payload).length > 0) {
      return { kind: 'trigger', payload, variables }
    }
    return { kind: 'task', variables }
  }
  return evalSampleInputSchema.parse(value)
}

/**
 * Parse a row's stored `tools` column. A legacy row stored a bare fixtures
 * record there, and its freeze flag on the OTHER column — so the legacy freeze
 * has to be passed in alongside. Freeze wins: it was the setting that actually
 * took effect, silently making any fixtures beside it dead.
 */
export function parseEvalTools(
  value: unknown,
  legacyFreezeTools?: boolean,
): EvalTools {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !('mode' in value)
  ) {
    if (legacyFreezeTools) return { mode: 'frozen' }
    return { mode: 'mocked', fixtures: evalFixturesSchema.parse(value) }
  }
  return evalToolsSchema.parse(value ?? { mode: 'mocked', fixtures: {} })
}

/** The legacy `freezeTools` flag on a row's stored `input` column, if any. */
export function legacyFreezeTools(input: unknown): boolean | undefined {
  return isLegacyInput(input) ? input.freezeTools : undefined
}

/** One graded check. `verdict`/`score`/`reason` are judge-check only. */
export const checkResultSchema = z.object({
  pass: z.boolean(),
  /** The judge's anchored verdict; absent on binary checks (and legacy rows). */
  verdict: judgeVerdictSchema.optional(),
  score: z.number().min(0).max(1).optional(),
  reason: z.string().optional(),
})
export type CheckResult = z.infer<typeof checkResultSchema>

/** Binary checks affect pass/fail only; judge checks also carry a score. */
export function isJudgeCheck(check: EvalCheck): boolean {
  return check.type === 'llm_judge'
}

/**
 * A frozen copy of everything a graded eval result was produced against, stored
 * on `wf_eval_result` at grade time. This is why Samples/Tests/Goals no longer
 * carry their own version counters: a run doesn't need the definitions' history,
 * only an immutable record of the exact state IT ran against — so it stays
 * reproducible as those definitions are edited afterward. The concrete agent
 * version that executed is not duplicated here; it lives in the produced
 * `wf_run`'s frozen `manifest` (reached via `wf_eval_result.wfRunId`).
 */
export type EvalRowSnapshot = {
  /** The Sample ("row") exactly as it ran + was graded. */
  row: {
    name: string
    description: string | null
    input: EvalSampleInput
    tools: EvalTools
    checks: CheckTree
  }
  /** The Goal ("set") target identity + trigger the row ran under. */
  target: {
    setId: string
    setName: string
    targetKind: string
    targetId: string
    /** The Goal's version pin: null when it floats to the target's latest. */
    targetVersion: number | null
    triggerKind: string
  }
}
