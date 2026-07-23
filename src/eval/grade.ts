import { generateObject, type LanguageModel } from 'ai'
import { z } from 'zod'

import type { AgentNodeMeta } from '../engine/nodes/agent'
import type { ToolNodeMeta } from '../engine/nodes/tool'

import type { CheckResult, CheckTree, EvalCheck, EvalMatch } from './checks'

// Phase 3 — the pure grading engine. Given a row's `checks` tree and a run's
// trace (`wf_run_step[]` + `wf_run.output`), produce a verdict:
//   • status — AND/OR reduction of EVERY check's pass flag (binary + judge).
//   • score  — weighted mean of the JUDGE checks' 0..1 scores ONLY (binary
//              checks never enter the score); null when a row has no judge check.
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
}

const DEFAULT_JUDGE_THRESHOLD = 0.7

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

const judgeSchema = z.object({
  score: z.number().min(0).max(1),
  reason: z.string(),
})

async function gradeJudge(
  check: Extract<EvalCheck, { type: 'llm_judge' }>,
  input: GradeRowInput,
): Promise<CheckResult & { score: number }> {
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
  const { object } = await generateObject({
    model: input.getModel(modelId),
    schema: judgeSchema,
    prompt: [
      'You are grading an AI system’s run against a rubric. Score how well',
      'the run satisfies the rubric from 0 (fails) to 1 (fully satisfies), and',
      'explain briefly. Judge ONLY against the rubric. The TOOL CALLS & RESULTS',
      'below are the context the model was given — use them to judge whether the',
      'output is grounded in (and consistent with) that context.',
      '',
      `RUBRIC:\n${check.rubric}`,
      '',
      `${outputLabel}:\n${JSON.stringify(graded)}`,
      '',
      `TOOL CALLS & RESULTS:\n${JSON.stringify(toolCalls)}`,
    ].join('\n'),
  })
  const threshold = check.threshold ?? DEFAULT_JUDGE_THRESHOLD
  return { pass: object.score >= threshold, score: object.score, reason: object.reason }
}

// ── row grading ─────────────────────────────────────────────────────────────

/**
 * Grade one row's checks against its run trace. Deterministic checks resolve
 * synchronously; judge checks are awaited (concurrently). A judge failure marks
 * the whole row `error`. Otherwise `status` is the AND/OR reduction of every
 * check's pass flag and `score` is the weighted mean of the judge scores.
 */
export async function gradeRow(input: GradeRowInput): Promise<GradeRowResult> {
  const { op, checks } = input.checks

  // Weighted judge accumulator, filled as judge checks resolve.
  let weightedScore = 0
  let weightSum = 0
  let judgeErrored = false

  const results = await Promise.all(
    checks.map(async (check): Promise<CheckResult> => {
      if (check.type !== 'llm_judge') return gradeBinary(check, input)
      try {
        const r = await gradeJudge(check, input)
        const weight = check.weight ?? 1
        weightedScore += r.score * weight
        weightSum += weight
        return r
      } catch (err) {
        judgeErrored = true
        return { pass: false, reason: `judge error: ${(err as Error).message}` }
      }
    }),
  )

  const passFlags = results.map((r) => r.pass)
  const reduced =
    op === 'and' ? passFlags.every(Boolean) : passFlags.some(Boolean)
  // An empty tree passes (nothing asserted) — matches `every`/`some` on [] only
  // for `and`; normalize `or` over no checks to pass too.
  const status: GradeRowResult['status'] = judgeErrored
    ? 'error'
    : checks.length === 0 || reduced
      ? 'pass'
      : 'fail'
  const score = weightSum > 0 ? weightedScore / weightSum : null
  return { status, score, checkResults: results }
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
