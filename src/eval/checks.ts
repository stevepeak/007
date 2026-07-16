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
    /** Judge model; falls back to a suite/run default when omitted. */
    modelId: z.string().optional(),
    /** 0..1 score cutoff mapping the judge's score to pass/fail. Default 0.7. */
    threshold: z.number().min(0).max(1).optional(),
    /** Relative weight of this judge's score in the row's mean. Default 1. */
    weight: z.number().min(0).optional(),
  }),
])
export type EvalCheck = z.infer<typeof evalCheckSchema>

/** The AND/OR reducer over a row's checks. */
export const checkTreeSchema = z.object({
  op: z.enum(['and', 'or']),
  checks: z.array(evalCheckSchema),
})
export type CheckTree = z.infer<typeof checkTreeSchema>

/** A row's initial condition — what the target is invoked with. */
export const evalInitialConditionSchema = z.object({
  triggerInput: z.record(z.string(), z.unknown()).optional(),
  promptVariables: z.record(z.string(), z.string()).optional(),
})
export type EvalInitialCondition = z.infer<typeof evalInitialConditionSchema>

/** Canned tool outputs keyed by tool id, consumed by read tools under simulate. */
export const evalFixturesSchema = z.record(z.string(), z.unknown())
export type EvalFixtures = z.infer<typeof evalFixturesSchema>

/** One graded check. `score`/`reason` are present only for judge checks. */
export const checkResultSchema = z.object({
  pass: z.boolean(),
  score: z.number().min(0).max(1).optional(),
  reason: z.string().optional(),
})
export type CheckResult = z.infer<typeof checkResultSchema>

/** Binary checks affect pass/fail only; judge checks also carry a score. */
export function isJudgeCheck(check: EvalCheck): boolean {
  return check.type === 'llm_judge'
}
