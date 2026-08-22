import { generateObject, NoObjectGeneratedError, type LanguageModel } from 'ai'
import { z } from 'zod'

import { errorFeedLine } from '../engine/error-detail'
import type { AgentNodeMeta } from '../engine/nodes/agent'
import type { ToolNodeMeta } from '../engine/nodes/tool'

import {
  JUDGE_CONFIDENCE_MAX,
  type CheckResult,
  type CheckTree,
  type EvalCheck,
  type EvalMatch,
} from './checks'

// Phase 3 — the pure grading engine. Given a row's `checks` tree and a run's
// trace (`wf_run_step[]` + `wf_run.output`), produce a verdict:
//   • status — AND/OR reduction of EVERY check's pass flag (binary + judge).
//   • score  — the JUDGE checks' pass rate ONLY — binary checks never enter the
//              score; null when a row has no judge check. Judges answer
//              pass/fail, so a row's quality number is simply how many of those
//              judgements went its way; the confidence each judge reports is
//              kept per-check rather than folded in, because how SURE a judge
//              was is not a statement about how GOOD the output was.
// Deterministic checks read the trace synchronously; only `llm_judge` needs a
// model (via `getModel`). No database, no Cloudflare — unit-testable with plain
// fixtures. Shared by the server's `gradeEvalResult` (Phase 4) and `bun:test`.

/** The minimal `wf_run_step` shape the grader reads. */
export type GradeStep = {
  nodeId: string
  nodeKind: string
  input?: unknown
  output?: unknown
  /** Tool nodes: `{ toolId, args }`. Agent nodes: an {@link AgentNodeMeta}. */
  meta?: unknown
}

/** Resolves a judge `modelId` to a model. Bound by the caller (server/test). */
export type GradeModelFactory = (modelId: string) => LanguageModel

export type GradeRowInput = {
  checks: CheckTree
  steps: GradeStep[]
  output: unknown
  /** Required only when the tree contains an `llm_judge` check. */
  getModel?: GradeModelFactory
  /** Judge model used when a judge check omits its own `modelId`. */
  defaultJudgeModelId?: string
  /**
   * Synthesis-mode context — tool calls STAGED in the row's seeded conversation
   * (see `collectSeededToolCalls`). Under `freezeTools` the agent calls nothing,
   * so these never land in `steps`; they're passed here so an `llm_judge` can
   * grade the answer's faithfulness to the context the model was shown. Binary
   * `tool_called` / `tool_args_match` checks IGNORE these — those grade what the
   * agent actually did, not what was pre-seeded.
   */
  seededToolCalls?: ToolInvocation[]
}

export type GradeRowResult = {
  status: 'pass' | 'fail' | 'error'
  score: number | null
  checkResults: CheckResult[]
  /**
   * Human explanation for an `error` status, destined for the `error` column
   * `recordEvalFailure` already writes and the run report already renders.
   *
   * An errored row is the one case with no per-check verdict that explains
   * ITSELF: an empty tree has no checks at all, and a judge that threw buries
   * its reason inside `checkResults[i].reason`, which the report's summary never
   * surfaces. Without this the reader sees a red cell and an empty banner.
   * Undefined for pass/fail, where `checkResults` already tells the story.
   */
  error?: string
}

// ── trace helpers ───────────────────────────────────────────────────────────

type ToolInvocation = { toolId: string; args: unknown; output: unknown }

/**
 * Every tool invocation in the run, from BOTH shapes: a workflow Tool node (a
 * top-level `tool` step with `meta.{toolId,args}`) and an Agent node's internal
 * loop (`meta.steps[].toolCalls[]`). An agent-eval and a workflow-eval therefore
 * grade `tool_called` / `tool_args_match` identically.
 */
function collectToolCalls(steps: GradeStep[]): ToolInvocation[] {
  const calls: ToolInvocation[] = []
  for (const s of steps) {
    if (s.nodeKind === 'tool') {
      const m = s.meta as Partial<ToolNodeMeta> | undefined
      if (m?.toolId) calls.push({ toolId: m.toolId, args: m.args, output: s.output })
    } else if (s.nodeKind === 'agent') {
      const m = s.meta as AgentNodeMeta | undefined
      for (const st of m?.steps ?? []) {
        for (const tc of st.toolCalls ?? []) {
          calls.push({ toolId: tc.toolName, args: tc.input, output: tc.output })
        }
      }
    }
  }
  return calls
}

/** Walk a dot / bracket path (`a.b[0].c`) into a value; whole value if no path. */
function valueAtPath(value: unknown, path?: string): unknown {
  if (!path) return value
  const parts = path
    .replaceAll(/\[(\w+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
  let cur: unknown = value
  for (const part of parts) {
    if (cur == null) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a == null || b == null) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    return (
      ka.length === kb.length &&
      ka.every((k) =>
        deepEqual(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        ),
      )
    )
  }
  return false
}

/**
 * Compare an actual value to the check's expected `value` under a match mode.
 * `equals` = deep equality; `contains` = substring (strings) or membership
 * (arrays); `regex` = the expected as a RegExp over the stringified actual.
 * `jsonpath` is a v1 alias for `equals` after `path` selection (richer JSONPath
 * matching is parked — see the plan's ideas list).
 */
function matches(actual: unknown, match: EvalMatch, expected: unknown): boolean {
  switch (match) {
    case 'equals':
    case 'jsonpath':
      return deepEqual(actual, expected)
    case 'contains':
      if (typeof actual === 'string') return actual.includes(String(expected))
      if (Array.isArray(actual)) return actual.some((x) => deepEqual(x, expected))
      return false
    case 'regex':
      try {
        return new RegExp(String(expected)).test(
          typeof actual === 'string' ? actual : JSON.stringify(actual),
        )
      } catch {
        return false
      }
  }
}

function preview(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  return s == null ? 'undefined' : s.length > 120 ? `${s.slice(0, 117)}…` : s
}

// ── deterministic checks ────────────────────────────────────────────────────

function gradeBinary(check: EvalCheck, input: GradeRowInput): CheckResult {
  const calls = collectToolCalls(input.steps)
  switch (check.type) {
    case 'tool_called': {
      const called = calls.some((c) => c.toolId === check.toolId)
      const pass = called === check.called
      return pass
        ? { pass }
        : {
            pass,
            reason: `expected ${check.toolId} ${check.called ? 'to be called' : 'NOT to be called'}, but it was ${called ? 'called' : 'not called'}`,
          }
    }
    case 'tool_args_match': {
      const forTool = calls.filter((c) => c.toolId === check.toolId)
      if (forTool.length === 0) {
        return { pass: false, reason: `${check.toolId} was never called` }
      }
      const pass = forTool.some((c) =>
        matches(valueAtPath(c.args, check.path), check.match, check.value),
      )
      return pass
        ? { pass }
        : {
            pass,
            reason: `no ${check.toolId} call had args${check.path ? `.${check.path}` : ''} ${check.match} ${preview(check.value)}; actual: ${preview(valueAtPath(forTool[0]?.args, check.path))}`,
          }
    }
    case 'node_visited': {
      const visited = input.steps.some((s) => s.nodeId === check.nodeId)
      const pass = visited === check.visited
      return pass
        ? { pass }
        : {
            pass,
            reason: `expected node ${check.nodeId} ${check.visited ? 'to run' : 'NOT to run'}, but it ${visited ? 'ran' : 'did not run'}`,
          }
    }
    case 'node_input_match': {
      const step = input.steps.find((s) => s.nodeId === check.nodeId)
      if (!step) {
        return { pass: false, reason: `node ${check.nodeId} did not run` }
      }
      const actual = valueAtPath(step.input, check.path)
      const pass = matches(actual, check.match, check.value)
      return pass
        ? { pass }
        : {
            pass,
            reason: `node ${check.nodeId} input${check.path ? `.${check.path}` : ''} did not ${check.match} ${preview(check.value)}; actual: ${preview(actual)}`,
          }
    }
    case 'output_match': {
      const actual = valueAtPath(input.output, check.path)
      const pass = matches(actual, check.match, check.value)
      return pass
        ? { pass }
        : {
            pass,
            reason: `output${check.path ? `.${check.path}` : ''} did not ${check.match} ${preview(check.value)}; actual: ${preview(actual)}`,
          }
    }
    /* c8 ignore next */
    default:
      return { pass: false, reason: 'unknown binary check' }
  }
}

// ── judge check ─────────────────────────────────────────────────────────────

// `reason` is declared FIRST on purpose: `generateObject` emits the object's
// keys in schema order, so the judge has to write its justification before it
// commits to a verdict. Reversed, the verdict comes out first and the reason is
// a post-hoc rationalization of a decision the model already guessed at.
//
// `confidence` comes last, after the decision it is about: asked for first, the
// model picks a number and then reasons toward a verdict that matches it. It is
// also deliberately UNBOUNDED here and clamped below instead — a min/max would
// turn "9.5" or "95" into a `NoObjectGeneratedError` that costs the whole check
// its verdict, and the verdict is the part worth having. The prompt states the
// scale; the code enforces it.
const judgeSchema = z.object({
  reason: z.string(),
  pass: z.boolean(),
  confidence: z
    .number()
    .describe(`Confidence in the verdict, 0 to ${JUDGE_CONFIDENCE_MAX}.`),
})

// The written anchors that make the decision repeatable. These, not the rubric,
// are what stop one judge run from passing output that the next one fails.
const PASS_ANCHOR =
  'the output satisfies the rubric. Cosmetic shortfalls a reviewer would not ask to change still pass.'
const FAIL_ANCHOR =
  'the output does not satisfy the rubric, satisfies it only by accident, or a reviewer would ask for a concrete fix (a gap, a hedge, an unsupported claim).'

// Anchors for the confidence number, so it means the same thing across runs and
// across models. It measures how far from the line the call was — NOT how good
// the output is. A confident fail and a confident pass both report 10.
const CONFIDENCE_ANCHORS = [
  '0–3 — a coin flip: the rubric is ambiguous here, or the output sits right on the line.',
  '4–7 — a defensible call, but a careful reviewer could reach the other verdict.',
  '8–10 — no real doubt: the output clearly does, or clearly does not, satisfy the rubric.',
]

/**
 * How many times one judge call may be issued before giving up.
 *
 * `generateObject` already defaults to `maxRetries: 2`, but that only covers
 * RETRYABLE provider rejections (429, 503) — it fires inside the call, before a
 * response exists. A response that arrives intact and simply isn't the
 * `{reason, pass, confidence}` object the schema asked for throws
 * `NoObjectGeneratedError` on the FIRST occurrence and is never retried, so a
 * judge that merely fumbled its JSON used to cost the whole cell its verdict.
 * One extra attempt turns that formatting flake into a graded row. Same bound
 * and same reasoning as `STRUCTURED_MAX_ATTEMPTS` on the structured agent path
 * (`engine/nodes/agent-generation.ts`). Anything else — a provider rejection, a
 * missing model — has either already been retried or will never succeed, so it
 * propagates untouched rather than being tried again here.
 */
const JUDGE_MAX_ATTEMPTS = 2

async function gradeJudge(
  check: Extract<EvalCheck, { type: 'llm_judge' }>,
  input: GradeRowInput,
): Promise<CheckResult & { confidence: number }> {
  const modelId = check.modelId ?? input.defaultJudgeModelId
  if (!input.getModel || !modelId) {
    throw new Error(
      'llm_judge check requires a getModel factory and a judge modelId (per-check or defaultJudgeModelId)',
    )
  }
  // Tool calls the model was shown: the ones it actually made in the run, plus
  // any STAGED in a seeded conversation (synthesis mode — under `freezeTools`
  // the agent calls nothing, so the seeded context is the only context). Each
  // carries its OUTPUT so the judge can grade whether the answer stayed faithful
  // to what was retrieved, not just whether the right tool was named.
  const toolCalls = [
    ...(input.seededToolCalls ?? []),
    ...collectToolCalls(input.steps),
  ].map((c) => ({ tool: c.toolId, args: c.args, output: c.output }))
  // The judge grades the whole output, or — when the check pins a `path` — only
  // the value at that path, so a rubric can target one known field.
  const graded = valueAtPath(input.output, check.path)
  const outputLabel = check.path ? `RUN OUTPUT (at \`${check.path}\`)` : 'RUN OUTPUT'
  // Built once, outside the retry loop, so a re-issue re-sends an IDENTICAL
  // request — a retry that also changed the prompt would be a different
  // experiment, not a second attempt at the same one.
  const prompt = [
    'You are grading an AI system’s run against a rubric. Write a one- or',
    'two-sentence justification citing the specific part of the output you are',
    'reacting to, THEN decide whether it passes:',
    `  • pass — ${PASS_ANCHOR}`,
    `  • fail — ${FAIL_ANCHOR}`,
    '',
    `Finally, rate your CONFIDENCE in that decision from 0 to ${JUDGE_CONFIDENCE_MAX}.`,
    'Confidence is about how clear-cut the call was, not about how good the',
    'output is — a clear failure is a 10, not a 0:',
    ...CONFIDENCE_ANCHORS.map((a) => `  • ${a}`),
    '',
    'Judge ONLY against the rubric — ignore anything the rubric does not ask',
    'about, however good or bad. The TOOL CALLS & RESULTS below are the context',
    'the model was given; use them to judge whether the output is grounded in',
    '(and consistent with) that context.',
    '',
    `RUBRIC:\n${check.rubric}`,
    '',
    `${outputLabel}:\n${JSON.stringify(graded)}`,
    '',
    `TOOL CALLS & RESULTS:\n${JSON.stringify(toolCalls)}`,
  ].join('\n')
  // The model factory is resolved once: `getModel` is a host seam and may build
  // a client, which the retry has no reason to redo.
  const model = input.getModel(modelId)
  let object: z.infer<typeof judgeSchema>
  for (let attempt = 1; ; attempt++) {
    try {
      ;({ object } = await generateObject({ model, schema: judgeSchema, prompt }))
      break
    } catch (err) {
      if (attempt >= JUDGE_MAX_ATTEMPTS || !NoObjectGeneratedError.isInstance(err)) {
        throw err
      }
    }
  }
  return {
    pass: object.pass,
    // Clamped and rounded rather than trusted: the stored value is read as
    // "N out of 10" everywhere downstream, so a model that answers 11 for
    // emphasis or 7.5 for precision must not put a number on that scale that
    // it can't carry.
    confidence: Math.round(
      Math.min(Math.max(object.confidence, 0), JUDGE_CONFIDENCE_MAX),
    ),
    reason: object.reason,
  }
}

// ── row grading ─────────────────────────────────────────────────────────────

/**
 * A check's verdict during reduction, before it is flattened back to the stored
 * {@link CheckResult}. `unknown` is the third value: a judge that THREW reached
 * no verdict at all, which is a different thing from a judge that returned a
 * poor one. Internal only — `CheckResult.pass` stays a plain boolean, so the
 * persisted `checkResults` JSON and its DTO are untouched by this distinction.
 */
type GradedCheck = { result: CheckResult; verdict: boolean | 'unknown' }

/**
 * Grade one row's checks against its run trace. Deterministic checks resolve
 * synchronously; judge checks are awaited (concurrently). `status` is a
 * three-valued reduction over every check (see below) and `score` is the pass
 * rate across the judges that actually answered.
 */
export async function gradeRow(input: GradeRowInput): Promise<GradeRowResult> {
  const { op, checks } = input.checks

  // A sample that asserts nothing used to report `pass` — the most confident
  // green cell in the report and the least earned, inflating every pass rate it
  // appeared in. It isn't a `fail` either (the target may be perfectly fine);
  // it's an unanswerable question, which is what `error` already means here.
  // Returned BEFORE the reducer on purpose: the Kleene rules below would land an
  // empty `and` on `pass` and an empty `or` on `fail`, and neither is true.
  if (checks.length === 0) {
    return {
      status: 'error',
      score: null,
      checkResults: [],
      error:
        'This sample has no checks — nothing was asserted. Add at least one check so the run has something to verify.',
    }
  }

  // Judge pass-rate accumulator, filled as judge checks resolve. A judge that
  // threw increments neither: the row's score is over the judges that answered.
  let judgesPassed = 0
  let judgesAnswered = 0
  // Every judge that threw, so an errored row can explain itself rather than
  // rendering as a red cell above an empty banner.
  const judgeErrors: string[] = []

  const graded = await Promise.all(
    checks.map(async (check): Promise<GradedCheck> => {
      if (check.type !== 'llm_judge') {
        const result = gradeBinary(check, input)
        return { result, verdict: result.pass }
      }
      try {
        const r = await gradeJudge(check, input)
        judgesAnswered += 1
        if (r.pass) judgesPassed += 1
        return { result: r, verdict: r.pass }
      } catch (err) {
        // `errorFeedLine`, not `err.message`: a bare message on an APICallError
        // is "Bad Request" and on a RetryError it's "Failed after N attempts",
        // both useless. The helper keeps the status code, the attempt count and
        // — for a structured failure — the finish reason, which is the whole
        // diagnosis: it says whether the judge's answer was TRUNCATED or merely
        // malformed.
        const reason = `judge error: ${errorFeedLine(err)}`
        judgeErrors.push(reason)
        // Stored `pass: false` keeps the check rendering as not-passing, which
        // is honest; only the reduction below treats it as unknown.
        return { result: { pass: false, reason }, verdict: 'unknown' }
      }
    }),
  )

  const results = graded.map((g) => g.result)
  // Three-valued (Kleene) reduction. A judge that errored is UNKNOWN, not false:
  // its verdict was never reached, so it can neither fail an AND nor pass an OR
  // — but it must not silently vanish either. A definite answer wins; failing
  // that, an unknown makes the whole row unknown:
  //
  //   and — any definite FALSE decides it (`fail`): one broken check cannot
  //         rescue a row that another check already sank. Otherwise an unknown
  //         leaves the row undecidable (`error`). All definite true → `pass`.
  //   or  — any definite TRUE decides it (`pass`), for the mirror reason: the
  //         row's verdict IS knowable even though a judge blew up. Otherwise an
  //         unknown → `error`. All definite false → `fail`.
  //
  // The `or` case is the bug this replaces: a row with a passing deterministic
  // check used to report `error` just because a judge beside it timed out.
  const verdicts = graded.map((g) => g.verdict)
  const hasUnknown = verdicts.includes('unknown')
  const status: GradeRowResult['status'] =
    op === 'and'
      ? verdicts.includes(false)
        ? 'fail'
        : hasUnknown
          ? 'error'
          : 'pass'
      : verdicts.includes(true)
        ? 'pass'
        : hasUnknown
          ? 'error'
          : 'fail'
  // A judge that threw reached no verdict, so the rate is over the judges that
  // actually answered. `null` when no judge answered at all — a row of purely
  // binary checks has a pass/fail, not a score.
  const score = judgesAnswered > 0 ? judgesPassed / judgesAnswered : null
  return {
    status,
    score,
    checkResults: results,
    error: status === 'error' && judgeErrors.length > 0 ? judgeErrors.join('; ') : undefined,
  }
}

// ── aggregation ─────────────────────────────────────────────────────────────

export type RowOutcome = { status: 'pass' | 'fail' | 'error'; score: number | null }

export type Rollup = {
  total: number
  passed: number
  failed: number
  errored: number
  passRate: number
  /** Mean over rows that HAVE a score (judge-bearing); null when none do. */
  meanScore: number | null
}

/** Pass rate + judge-only mean score over a set of row outcomes. */
export function rollup(results: RowOutcome[]): Rollup {
  const total = results.length
  const passed = results.filter((r) => r.status === 'pass').length
  const errored = results.filter((r) => r.status === 'error').length
  const scored = results.filter((r) => r.score != null)
  const meanScore =
    scored.length > 0
      ? scored.reduce((sum, r) => sum + (r.score ?? 0), 0) / scored.length
      : null
  return {
    total,
    passed,
    failed: total - passed,
    errored,
    passRate: total > 0 ? passed / total : 0,
    meanScore,
  }
}
