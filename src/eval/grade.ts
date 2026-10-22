import { resolvePath } from '../engine/binding'
import { agentToolCalls } from '../engine/cost'
import {
  buildProviderQuestion,
  chunkQuestions,
  DEFAULT_DECISION_THRESHOLD,
  resolveVerdicts,
  type Decider,
  type DecisionQuestion,
  type DecisionVerdict,
} from '../engine/decision'
import { errorFeedLine } from '../engine/error-detail'
import {
  isJudgeCheck,
  JUDGE_CONFIDENCE_MAX,
  type CheckResult,
  type CheckTree,
  type DecisionExpectation,
  type EvalCheck,
  type EvalMatch,
  upgradeLegacyChecks,
} from '../engine/eval-schema'
import type { ToolNodeMeta } from '../engine/nodes/tool'
import { stableEqual } from '../engine/stable-stringify'
import { truncate } from '../engine/text'

// Phase 3 — the pure grading engine. Given a row's `checks` tree and a run's
// trace (`wf_run_step[]` + `wf_run.output`), produce a verdict:
//   • status — AND/OR reduction of EVERY check's pass flag (binary + judge).
//   • score  — the JUDGE checks' pass rate ONLY — binary checks never enter the
//              score; null when a row has no judge check. Judges answer
//              pass/fail, so a row's quality number is simply how many of those
//              judgements went its way; the confidence each judge reports is
//              kept per-check rather than folded in, because how SURE a judge
//              was is not a statement about how GOOD the output was.
// Deterministic checks read the trace synchronously; only judge checks need a
// provider (via `getDecider`). No database, no Cloudflare — unit-testable with plain
// fixtures. Shared by the server's `gradeEvalResult` (Phase 4) and `bun:test`.

/** The minimal `wf_run_step` shape the grader reads. */
export type GradeStep = {
  nodeId: string
  nodeKind: string
  input?: unknown
  output?: unknown
  /** Tool nodes: `{ toolId, args }`. Agent nodes: an `AgentNodeMeta`. */
  meta?: unknown
}

/**
 * Resolves the run's decision judge id to a {@link Decider}. Bound by the caller
 * (server/test); optional for the same reason the SDK's `getDecider` is: a host
 * with no decision provider has no judge to grade with.
 */
export type GradeDeciderFactory = (modelId: string) => Decider

export type GradeRowInput = {
  checks: CheckTree
  steps: GradeStep[]
  output: unknown
  /** Required only when the tree contains a judge check. */
  getDecider?: GradeDeciderFactory
  /** The run's decision judge: the model every judge check is graded by. */
  decisionJudgeModelId?: string
  /**
   * Synthesis-mode context — tool calls STAGED in the row's seeded conversation
   * (see `collectSeededToolCalls`). Under `freezeTools` the agent calls nothing,
   * so these never land in `steps`; they're passed here so a judge can
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
      if (m?.toolId)
        calls.push({ toolId: m.toolId, args: m.args, output: s.output })
    } else if (s.nodeKind === 'agent') {
      calls.push(...agentToolCalls({ meta: s.meta }))
    }
  }
  return calls
}

/**
 * The binding path language ({@link resolvePath}) plus two extras check authors
 * already rely on: bracket indices (`a.b[0].c` reads as `a.b.0.c`) and a final
 * `.length` on an array or string. Kept here rather than in `resolvePath` so
 * workflow binding semantics stay exactly as they are. Whole value if no path.
 */
function valueAtPath(value: unknown, path?: string): unknown {
  if (!path) return value
  const dotted = path
    .replaceAll(/\[(\w+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
    .join('.')
  const parentPath = dotted.replace(/(?:^|\.)length$/, '')
  if (parentPath !== dotted) {
    const parent = resolvePath(value, parentPath)
    if (Array.isArray(parent) || typeof parent === 'string') return parent.length
  }
  return resolvePath(value, dotted)
}

/**
 * Compare an actual value to the check's expected `value` under a match mode.
 * `equals` = deep equality, where an `undefined` key equals a missing one;
 * `contains` = substring (strings) or membership (arrays); `regex` = the
 * expected as a RegExp over the stringified actual. `jsonpath` is a v1 alias
 * for `equals` after `path` selection (richer JSONPath matching is parked — see
 * the plan's ideas list).
 */
function matches(
  actual: unknown,
  match: EvalMatch,
  expected: unknown,
): boolean {
  switch (match) {
    case 'equals':
    case 'jsonpath':
      return stableEqual(actual, expected)
    case 'contains':
      if (typeof actual === 'string') return actual.includes(String(expected))
      if (Array.isArray(actual))
        return actual.some((x) => stableEqual(x, expected))
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
  return s == null ? 'undefined' : truncate({ text: s, max: 120 })
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
      const pass = forTool.some((c) => {
        return matches(
          valueAtPath(c.args, check.path),
          check.match,
          check.value,
        )
      })
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
    case 'decision_answers': {
      if (check.nodeId == null) return gradeDecisionAnswers(check, input.output)
      const step = input.steps.find((s) => s.nodeId === check.nodeId)
      if (!step) {
        return { pass: false, reason: `node ${check.nodeId} did not run` }
      }
      return gradeDecisionAnswers(check, step.output)
    }
    /* c8 ignore next */
    default:
      return { pass: false, reason: 'unknown binary check' }
  }
}

// ── decision matrix check ───────────────────────────────────────────────────

/**
 * Grade a decision agent's `{ verdict, answers }` against the expected matrix.
 *
 * Deterministic, and reads the SAME `DecisionVerdict` shape `resolveVerdicts`
 * produces — the answer has already been through the engine's interpretation
 * layer by the time it is persisted, so the threshold a boolean was judged at
 * is the agent's own and not one this check re-applies.
 *
 * Every mismatch is reported, not just the first: a matrix that got three of
 * five questions wrong should say so in one read, because the next edit is to
 * the questions and the author needs to know which ones.
 */
function gradeDecisionAnswers(
  check: Extract<EvalCheck, { type: 'decision_answers' }>,
  output: unknown,
): CheckResult {
  const result = output as
    | { verdict?: unknown; answers?: Record<string, DecisionVerdict> }
    | null
    | undefined
  const answers = result?.answers
  if (!answers || typeof answers !== 'object') {
    return {
      pass: false,
      reason:
        check.nodeId == null
          ? 'the run produced no decision answers — this check grades a decision agent, whose output is { verdict, because, answers }. On a workflow, set nodeId to the decision node'
          : `node ${check.nodeId} produced no decision answers — point nodeId at an agent node that runs a decision agent`,
    }
  }

  const misses: string[] = []
  if (check.verdict != null && result?.verdict !== check.verdict) {
    misses.push(
      `verdict expected ${check.verdict}, got ${preview(result?.verdict)}`,
    )
  }
  for (const expectation of check.expect) {
    const miss = expectationMiss(expectation, answers[expectation.questionId])
    if (miss) misses.push(miss)
  }
  return misses.length === 0
    ? { pass: true }
    : { pass: false, reason: misses.join('; ') }
}

/** One expectation's failure sentence, or null when it held. */
function expectationMiss(
  expectation: DecisionExpectation,
  verdict: DecisionVerdict | undefined,
): string | null {
  const id = expectation.questionId
  if (!verdict) return `${id} was not answered`
  // The winning outcome's share of the mass, on one scale for all three types —
  // the number `minProbability` is a floor on. For a boolean expecting `no`
  // that is `1 - p`, because "no with p(yes)=0.1" is a confident no.
  const confidenceOf = (key: string) => { return verdict.distribution.find((e) => e.key === key)?.probability ?? 0 }

  if (verdict.type === 'boolean') {
    if (expectation.yes != null && verdict.value !== expectation.yes) {
      return `${id} expected ${expectation.yes ? 'yes' : 'no'}, got ${verdict.value ? 'yes' : 'no'} (p=${verdict.probability.toFixed(2)})`
    }
    const p = expectation.yes === false ? 1 - verdict.probability : verdict.probability
    if (expectation.minProbability != null && p < expectation.minProbability) {
      return `${id} answered ${verdict.value ? 'yes' : 'no'} at ${p.toFixed(2)}, below the ${expectation.minProbability} the sample asked for`
    }
    return null
  }

  const actual = verdict.type === 'category' ? verdict.value : verdict.level
  if (expectation.key != null && actual !== expectation.key) {
    return `${id} expected ${expectation.key}, got ${actual}`
  }
  if (expectation.minProbability != null) {
    const p = confidenceOf(actual)
    if (p < expectation.minProbability) {
      return `${id} answered ${actual} at ${p.toFixed(2)}, below the ${expectation.minProbability} the sample asked for`
    }
  }
  return null
}

// ── judge checks ────────────────────────────────────────────────────────────
// Every judge is a `decision_judge`: a question put to the run's decision model,
// answered with a probability. A row's judges are asked TOGETHER — one decider
// request per output path, chunked only past the model's question cap — so ten
// judge checks cost one round trip, not ten.

type JudgeCheck = Extract<EvalCheck, { type: 'decision_judge' }>

/** A judge check's question plus how its answer becomes p(pass). */
type PreparedJudge = {
  question: DecisionQuestion
  /** The keys whose probability mass counts as a pass (unused for boolean). */
  passKeys: Set<string>
  /** How the reason names what was measured, e.g. `p(yes)`. */
  measured: string
}

/**
 * Validate one check and build its provider question. Throws on a check that
 * cannot be asked — a category with no expected option, a scale whose
 * `minLevel` isn't one of its levels — so the row reports the author's mistake
 * as that check's error instead of grading it against nothing.
 */
export function prepareJudge(check: JudgeCheck, id: string): PreparedJudge {
  const answer = check.answer ?? 'boolean'
  const choices = (check.choices ?? [])
    .map((c) => c.trim())
    .filter(Boolean)
    .map((key) => ({ key }))
  const question = buildProviderQuestion(
    { id, type: answer, prompt: check.rubric },
    choices,
    'This judge check',
  )
  if (answer === 'boolean') {
    return { question, passKeys: new Set(['yes']), measured: 'p(yes)' }
  }
  const keys = choices.map((c) => c.key)
  if (answer === 'category') {
    const expected = (check.expected ?? []).filter((k) => keys.includes(k))
    if (expected.length === 0) {
      throw new Error(
        'This category judge has no expected option — pick the option(s) that count as a pass.',
      )
    }
    return {
      question,
      passKeys: new Set(expected),
      measured: `p(${expected.join(' | ')})`,
    }
  }
  const from = keys.indexOf(check.minLevel ?? '')
  if (from < 0) {
    throw new Error(
      'This scale judge has no minimum level — pick the lowest level that counts as a pass.',
    )
  }
  return {
    question,
    passKeys: new Set(keys.slice(from)),
    measured: `p(≥ ${keys[from]})`,
  }
}

/** The probability a verdict gives the passing answer(s). */
function passProbability(verdict: DecisionVerdict, judge: PreparedJudge): number {
  if (verdict.type === 'boolean') return verdict.probability
  return Math.min(
    1,
    verdict.distribution
      .filter((e) => judge.passKeys.has(e.key))
      .reduce((sum, e) => sum + e.probability, 0),
  )
}

/** One judge's outcome: a verdict, or the error that kept it from one. */
type JudgeOutcome = { ok: true; result: CheckResult } | { ok: false; error: unknown }

/**
 * Grade every judge check of a row. Returns one outcome per entry of `checks`,
 * by index. Checks sharing an output path are asked in one decider request
 * (split by the decider's `maxQuestionsPerCall`); a request that fails fails
 * only the checks it carried.
 */
async function gradeJudges(
  checks: { check: JudgeCheck; index: number }[],
  input: GradeRowInput,
): Promise<Map<number, JudgeOutcome>> {
  const outcomes = new Map<number, JudgeOutcome>()
  if (checks.length === 0) return outcomes
  const modelId = input.decisionJudgeModelId
  if (!input.getDecider || !modelId) {
    const error = new Error(
      'Judge checks need the run\'s decisionJudgeModelId and a getDecider factory. A host with no decision provider cannot grade them — see WfSdkConfig.getDecider.',
    )
    for (const { index } of checks) outcomes.set(index, { ok: false, error })
    return outcomes
  }
  const decider = input.getDecider(modelId)
  // The tool calls the run made are folded into the state: under synthesis mode
  // the seeded calls are the only context the model was given, so a question
  // about groundedness has to see them.
  const toolCalls = [
    ...(input.seededToolCalls ?? []),
    ...collectToolCalls(input.steps),
  ].map((c) => ({ tool: c.toolId, args: c.args, output: c.output }))

  const byPath = new Map<string, { judge: PreparedJudge; check: JudgeCheck; index: number }[]>()
  for (const { check, index } of checks) {
    try {
      const judge = prepareJudge(check, `c${index}`)
      const path = check.path ?? ''
      byPath.set(path, [...(byPath.get(path) ?? []), { judge, check, index }])
    } catch (error) {
      outcomes.set(index, { ok: false, error })
    }
  }

  await Promise.all(
    [...byPath].flatMap(([path, group]) => {
      const state = {
        output: valueAtPath(input.output, path || undefined),
        outputPath: path || null,
        toolCallsAndResults: toolCalls,
      }
      return chunkQuestions(
        group.map((g) => g.judge.question),
        decider.maxQuestionsPerCall,
      ).map(async (questions) => {
        const members = group.filter((g) => questions.includes(g.judge.question))
        try {
          const response = await decider({ state, questions })
          for (const { judge, check, index } of members) {
            const threshold = check.threshold ?? DEFAULT_DECISION_THRESHOLD
            const verdict = resolveVerdicts([judge.question], response.answers, {
              threshold,
            })[judge.question.id]
            const probability = passProbability(verdict, judge)
            const pass = probability >= threshold
            outcomes.set(index, {
              ok: true,
              result: {
                pass,
                probability,
                // On the 0..10 the stored `confidence` is read as everywhere
                // downstream: how far from a coin flip the answer landed.
                confidence: Math.round(
                  Math.abs(2 * probability - 1) * JUDGE_CONFIDENCE_MAX,
                ),
                reason: `${judge.measured}=${probability.toFixed(2)} ${
                  pass ? '≥' : '<'
                } ${threshold.toFixed(2)} (${response.modelId ?? modelId})`,
              },
            })
          }
        } catch (error) {
          for (const { index } of members) outcomes.set(index, { ok: false, error })
        }
      })
    }),
  )
  return outcomes
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
 * synchronously; judge checks are batched into decider calls. `status` is a
 * three-valued reduction over every check (see below) and `score` is the pass
 * rate across the judges that actually answered.
 */
export async function gradeRow(input: GradeRowInput): Promise<GradeRowResult> {
  const { op, checks } = upgradeLegacyChecks(input.checks)

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

  const judgeOutcomes = await gradeJudges(
    checks
      .map((check, index) => ({ check, index }))
      .filter((c): c is { check: JudgeCheck; index: number } => {
        return isJudgeCheck(c.check)
      }),
    input,
  )
  const graded = checks.map((check, index): GradedCheck => {
    const outcome = judgeOutcomes.get(index)
    if (!outcome) {
      const result = gradeBinary(check, input)
      return { result, verdict: result.pass }
    }
    if (outcome.ok) {
      judgesAnswered += 1
      if (outcome.result.pass) judgesPassed += 1
      return { result: outcome.result, verdict: outcome.result.pass }
    }
    // `errorFeedLine`, not `err.message`: a bare message on an APICallError is
    // "Bad Request" and on a RetryError it's "Failed after N attempts", both
    // useless. The helper keeps the status code and the attempt count.
    const reason = `judge error: ${errorFeedLine(outcome.error)}`
    judgeErrors.push(reason)
    // Stored `pass: false` keeps the check rendering as not-passing, which is
    // honest; only the reduction below treats it as unknown.
    return { result: { pass: false, reason }, verdict: 'unknown' }
  })

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
    error:
      status === 'error' && judgeErrors.length > 0
        ? judgeErrors.join('; ')
        : undefined,
  }
}

// ── aggregation ─────────────────────────────────────────────────────────────

export type RowOutcome = {
  status: 'pass' | 'fail' | 'error'
  score: number | null
}

/**
 * A run's headline counts. `failed` is every row that did NOT pass — failed AND
 * errored — because it pairs with `passed` to make `total`: it is what
 * `wf_eval_run.failed` stores and what pass rate is the complement of. An
 * errored row produced no verdict, which for "did the agent pass?" is a miss.
 * `errored` is the subset that never reached a verdict, kept so a report can
 * tell an outage from a regression without re-reading the results.
 */
export type Rollup = {
  total: number
  passed: number
  /** Not passed: failed + errored. */
  failed: number
  /** The part of `failed` with no verdict at all. */
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
