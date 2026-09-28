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

// A check carries NO human-authored metadata — no title, no description. Its
// name is always derived from what it asserts (see `describeCheck` in the UI),
// so the two can't drift apart. Rows saved before that decision still hold a
// stray `label`/`description` in their JSON; zod strips unknown keys, so they
// validate on read and disappear on the next write.

// ── Judge output ────────────────────────────────────────────────────────────
// An LLM judge returns a DECISION and how sure it is of it, never a quality
// float. A model asked for "a score from 0 to 1" produces numbers it cannot
// defend — 0.72 vs 0.68 is noise, and two runs of the same output drift by more
// than the cutoff separating pass from fail. Pass/fail is a judgement a model
// can actually make repeatably; confidence says how close to the line it was,
// without pretending that closeness is a measure of quality.

/** How sure the judge is of its own verdict, 0 (a coin flip) to 10 (certain). */
export const JUDGE_CONFIDENCE_MAX = 10

// A single assertion. Two families, split by how they produce a verdict:
//   • binary/deterministic — pass|fail read straight off the run trace.
//   • subjective/scored    — an LLM judge returns pass|fail AND a 0..1 score.
export const evalCheckSchema = z.discriminatedUnion('type', [
  // ── binary / deterministic ────────────────────────────────────────────────
  z.object({
    type: z.literal('tool_called'),
    toolId: z.string(),
    /** Assert the tool WAS (true) or was NOT (false) called during the run. */
    called: z.boolean(),
  }),
  z.object({
    type: z.literal('tool_args_match'),
    toolId: z.string(),
    /** Optional JSON path into the recorded `meta.args`; omit = whole object. */
    path: z.string().optional(),
    match: evalMatchSchema,
    value: z.unknown(),
  }),
  z.object({
    type: z.literal('node_visited'),
    nodeId: z.string(),
    visited: z.boolean(),
  }),
  z.object({
    type: z.literal('node_input_match'),
    nodeId: z.string(),
    /** Optional JSON path into the node's recorded `input`; omit = whole. */
    path: z.string().optional(),
    match: evalMatchSchema,
    value: z.unknown(),
  }),
  z.object({
    type: z.literal('output_match'),
    /** Optional JSON path into the run `output`; omit = whole object. */
    path: z.string().optional(),
    match: evalMatchSchema,
    value: z.unknown(),
  }),
  // ── subjective / scored ───────────────────────────────────────────────────
  /**
   * A calibrated judge: one boolean question put to a DECISION model (see the
   * SDK's `decision.ts`), which answers with a probability rather than prose.
   *
   * The same job as `llm_judge`, done by something built for it. An LLM judge is
   * asked to write a verdict and then rate its own confidence in it, which is a
   * guess about a guess; a decider returns a probability and the check applies
   * the threshold. That makes a borderline row legible as 0.52 instead of as a
   * coin-flip `pass` with a cheerful 8/10 next to it.
   *
   * It is a lens beside `llm_judge`, not a replacement: a rubric that needs a
   * written critique still wants the LLM. Use this for the ones that reduce to a
   * yes/no you would otherwise be thresholding by eye.
   */
  z.object({
    type: z.literal('decision_judge'),
    /** The question, phrased so "yes" means the row passed. */
    rubric: z.string(),
    /** Optional JSON path into the run `output`; omit = whole output. */
    path: z.string().optional(),
    /** A DECISION model id; falls back to the suite/run default when omitted. */
    modelId: z.string().optional(),
    /**
     * Probability at or above which the row passes. Defaults to 0.5. This is the
     * author's line to draw, which is exactly why the provider never sees it.
     */
    threshold: z.number().min(0).max(1).optional(),
  }),
  z.object({
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
 * Every check type as `type { field, optional? }`, derived from the union.
 *
 * For the writers that have to DESCRIBE the vocabulary in prose rather than
 * render it as a picker — the MCP's `upsert_eval_sample`, whose description is
 * the only thing telling a model what a check may contain.
 *
 * It exists because that description drifted exactly as {@link EVAL_CHECK_TYPES}
 * was built to prevent: it hardcoded six types and missed `decision_judge`
 * entirely, along with both judges' `modelId` and the decision judge's
 * `threshold` — so the one check type built to produce a legible borderline
 * verdict could not be authored over MCP at all. A picker deriving from the
 * schema can't forget a type; a paragraph can, so the paragraph is generated.
 *
 * `?` marks a field the author declared `.optional()`, not merely one whose type
 * tolerates `undefined` — `value` on a match check is spelled `z.unknown()` and
 * would otherwise read as optional while a check without it compares against
 * nothing.
 */
export function describeCheckVocabulary(): string[] {
  return evalCheckSchema.options.map((option) => {
    const shape = option.shape as Record<string, { def: { type: string } }>
    const fields = Object.keys(shape)
      .filter((key) => key !== 'type')
      .map((key) => (shape[key].def.type === 'optional' ? `${key}?` : key))
    return `${option.shape.type.value} { ${fields.join(', ')} }`
  })
}

/** The subjective check types — the ones that need a provider to reach a verdict. */
export const JUDGE_CHECK_TYPES = ['llm_judge', 'decision_judge'] as const
export type JudgeCheckType = (typeof JUDGE_CHECK_TYPES)[number]

/**
 * The deterministic (non-judge) check type ids — graded straight off the run
 * trace. Everything except the judges.
 */
export const BINARY_CHECK_TYPES = EVAL_CHECK_TYPES.filter(
  (t): t is Exclude<EvalCheckType, JudgeCheckType> =>
    !(JUDGE_CHECK_TYPES as readonly string[]).includes(t),
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
// How the target's tools behave for this Sample — settled ONE TOOL AT A TIME,
// because that is the grain the question actually has. A sample-wide switch made
// an agent with a search tool and a memory tool answer the same question for
// both, so pinning one result meant pinning the other, and grading against live
// retrieval meant giving up determinism everywhere.
//
// A tool is `mocked` (returns its pinned `output`, or `{}` when nothing is
// pinned yet) or `live` (executes for real). There is no third setting: taking
// tools away entirely was a sample-wide mode, and a tool the agent can't call is
// not something you say about one tool.
//
// Write tools are neutralized in BOTH modes — an eval never writes.

export const evalToolModeSchema = z.enum(['mocked', 'live'])
export type EvalToolMode = z.infer<typeof evalToolModeSchema>

/** How ONE tool behaves for a Sample. */
export const evalToolSettingSchema = z.object({
  mode: evalToolModeSchema.default('mocked'),
  /**
   * The canned result this tool returns under `mocked`. Absent means nothing is
   * pinned yet — the editor starts from the tool's own output schema, and a run
   * hands the model `{}` until something is saved.
   */
  output: z.unknown().optional(),
})
export type EvalToolSetting = z.infer<typeof evalToolSettingSchema>

export const evalToolsSchema = z.object({
  /**
   * What a tool with no entry of its own does. `mocked` for everything authored
   * against the per-tool editor; `live` only on a row migrated from the old
   * sample-wide Live mode, where "every read tool runs for real" was the whole
   * setting and the tool ids it applied to were never written down.
   */
  fallback: evalToolModeSchema.default('mocked'),
  /** Per-tool settings, keyed by tool id. A tool absent here takes `fallback`. */
  byTool: z.record(z.string(), evalToolSettingSchema).default({}),
})
export type EvalTools = z.infer<typeof evalToolsSchema>

/** The tool setting in force for one tool — its own entry, else the fallback. */
export function toolSetting(tools: EvalTools, toolId: string): EvalToolSetting {
  return tools.byTool[toolId] ?? { mode: tools.fallback }
}

/**
 * The canned outputs this setting supplies, keyed by tool id — the `fixtures`
 * the engine hands a mocked read tool. Only tools that are BOTH mocked and have
 * something pinned appear: a live tool has no canned result, and a mocked tool
 * with nothing pinned falls through to `{}` in the engine exactly as an unmocked
 * tool always did.
 */
export function toolFixtures(tools: EvalTools): EvalFixtures {
  const fixtures: EvalFixtures = {}
  for (const [toolId, setting] of Object.entries(tools.byTool)) {
    if (setting.mode === 'mocked' && setting.output !== undefined) {
      fixtures[toolId] = setting.output
    }
  }
  return fixtures
}

/** The per-tool modes the engine applies over its `fallback` default. */
export function toolModes(tools: EvalTools): Record<string, EvalToolMode> {
  return Object.fromEntries(
    Object.entries(tools.byTool).map(([toolId, s]) => [toolId, s.mode]),
  )
}

/** A Sample's tools, with one tool's setting replaced. */
export function withToolSetting(
  tools: EvalTools,
  toolId: string,
  setting: EvalToolSetting,
): EvalTools {
  return { ...tools, byTool: { ...tools.byTool, [toolId]: setting } }
}

/** The tool setting a new Sample starts from: every tool mocked, nothing pinned. */
export function defaultEvalTools(): EvalTools {
  return { fallback: 'mocked', byTool: {} }
}

// ── Derived: what kind of test is this? ─────────────────────────────────────
// The testing LAYER a Sample belongs to is a function of its input and its
// tools, never a stored field — so it can't drift from the settings it names.
//
// Per-tool settings mean a sample can now sit in two layers at once (one tool
// pinned, another live). The name reports the STRONGEST claim it makes: any tool
// running for real is what decides whether the sample is reproducible, so that
// wins over the pinned ones beside it.

export type EvalSampleLayer = 'io' | 'trajectory' | 'integration'

export function evalSampleLayer(
  _input: EvalSampleInput,
  tools: EvalTools,
): EvalSampleLayer {
  const settings = Object.values(tools.byTool)
  const anyLive =
    tools.fallback === 'live' || settings.some((s) => s.mode === 'live')
  if (anyLive) return 'integration'
  // Something actually pinned = a trajectory test; nothing pinned is just an
  // input → output test, whatever the tools would have returned.
  return Object.keys(toolFixtures(tools)).length > 0 ? 'trajectory' : 'io'
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
 * Parse a row's stored `tools` column, upgrading both older shapes on the way
 * through — the sample-wide `{ mode, fixtures }` tri-state, and before that a
 * bare fixtures record with its freeze flag on the OTHER column (which is why
 * the legacy freeze is passed in alongside).
 *
 * The three old modes land as:
 *  • `mocked` — each fixture becomes that tool's pinned output. Identical
 *    behavior: the same tools return the same results.
 *  • `live` — `fallback: 'live'`, because "every read tool runs for real" never
 *    recorded WHICH tools it applied to. Every tool reads as Live, which is what
 *    the row meant, and pinning one now says so explicitly.
 *  • `frozen` — the agent no longer runs without tools; per-tool settings can't
 *    express taking them all away. The row becomes all-mocked with nothing
 *    pinned, so its tools return `{}` instead of not existing. A synthesis
 *    sample that staged its context in a seeded conversation still grades the
 *    same answer, but the agent CAN now call a tool instead of answering from
 *    the staged turns alone — worth re-reading those samples once.
 */
export function parseEvalTools(
  value: unknown,
  legacyFreezeTools?: boolean,
): EvalTools {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    // Pre-split: a bare fixtures record, freeze carried on the input column.
    if (!('mode' in record) && !('byTool' in record)) {
      if (legacyFreezeTools) return defaultEvalTools()
      return fixturesToTools(evalFixturesSchema.parse(record))
    }
    if ('mode' in record) {
      if (record.mode === 'live') return { fallback: 'live', byTool: {} }
      if (record.mode === 'frozen') return defaultEvalTools()
      return fixturesToTools(evalFixturesSchema.parse(record.fixtures ?? {}))
    }
  }
  return evalToolsSchema.parse(value ?? defaultEvalTools())
}

/** Each canned output as its own tool's pinned `mocked` setting. */
function fixturesToTools(fixtures: EvalFixtures): EvalTools {
  return {
    fallback: 'mocked',
    byTool: Object.fromEntries(
      Object.entries(fixtures).map(([toolId, output]) => [
        toolId,
        { mode: 'mocked' as const, output },
      ]),
    ),
  }
}

/** The legacy `freezeTools` flag on a row's stored `input` column, if any. */
export function legacyFreezeTools(input: unknown): boolean | undefined {
  return isLegacyInput(input) ? input.freezeTools : undefined
}

/**
 * One graded check. A binary check has nothing but `pass`; a judge also reports
 * how sure it was and why, which is what a reader needs to tell "wrong" from
 * "arguable" without re-reading the whole run.
 */
export const checkResultSchema = z.object({
  pass: z.boolean(),
  /** The judge's confidence in its own verdict, 0..10. Judge checks only. */
  confidence: z.number().min(0).max(JUDGE_CONFIDENCE_MAX).optional(),
  /** The judge's stated reason for the verdict. Judge checks only. */
  reason: z.string().optional(),
  /**
   * The raw probability a `decision_judge` returned, 0–1, before the threshold.
   * Kept beside `pass` rather than folded into it because it is the thing that
   * makes a calibrated judge worth having: 0.52 and 0.99 are both a pass, and
   * only one of them is worth looking at.
   */
  probability: z.number().min(0).max(1).optional(),
})
export type CheckResult = z.infer<typeof checkResultSchema>

/** Only judge checks are subjective — binary ones read straight off the trace. */
export function isJudgeCheck(
  check: EvalCheck,
): check is Extract<EvalCheck, { type: JudgeCheckType }> {
  return (JUDGE_CHECK_TYPES as readonly string[]).includes(check.type)
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
