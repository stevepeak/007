import { APICallError } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, test } from 'bun:test'

import type { CheckTree, JudgeVerdict } from './checks'
import {
  gradeRow,
  rollup,
  type GradeRowInput,
  type GradeStep,
} from './grade'

// Phase 3 — the pure grader. No DB, no Cloudflare; deterministic checks read a
// hand-built trace and the judge path uses a MockLanguageModelV3.

// A workflow-style trace: a top-level `tool` step + an `agent` step, plus a
// node whose input we can assert on.
const workflowSteps: GradeStep[] = [
  {
    nodeId: 'ask_order_id',
    nodeKind: 'agent',
    input: { reason: 'missing id' },
    output: { text: 'What is your order id?' },
    meta: {
      steps: [
        {
          stepNumber: 0,
          toolCalls: [
            { toolCallId: '1', toolName: 'lookup_order', input: { id: 'x' }, output: { found: false } },
          ],
        },
      ],
    },
  },
  {
    nodeId: 'refund',
    nodeKind: 'tool',
    input: { amount: 100 },
    output: { ok: true },
    meta: { toolId: 'issue_refund', args: { amount: 100, currency: 'USD' } },
  },
]

const output = { message: 'Your refund of $100 is on the way. ETA 3 days.' }

function grade(checks: CheckTree, extra?: Partial<GradeRowInput>) {
  return gradeRow({ checks, steps: workflowSteps, output, ...extra })
}

describe('gradeRow — deterministic checks', () => {
  test('tool_called finds a workflow Tool-node call', async () => {
    const r = await grade({
      op: 'and',
      checks: [{ type: 'tool_called', toolId: 'issue_refund', called: true }],
    })
    expect(r.status).toBe('pass')
    expect(r.checkResults[0]?.pass).toBe(true)
  })

  test('tool_called finds a call made INSIDE an agent node', async () => {
    const r = await grade({
      op: 'and',
      checks: [{ type: 'tool_called', toolId: 'lookup_order', called: true }],
    })
    expect(r.status).toBe('pass')
  })

  test('tool_called = false fails when the tool WAS called (with actual reason)', async () => {
    const r = await grade({
      op: 'and',
      checks: [{ type: 'tool_called', toolId: 'issue_refund', called: false }],
    })
    expect(r.status).toBe('fail')
    expect(r.checkResults[0]?.reason).toContain('issue_refund')
  })

  test('tool_args_match reads the tool’s recorded args at a path', async () => {
    const r = await grade({
      op: 'and',
      checks: [
        {
          type: 'tool_args_match',
          toolId: 'issue_refund',
          path: 'amount',
          match: 'equals',
          value: 100,
        },
      ],
    })
    expect(r.status).toBe('pass')
  })

  test('node_visited + node_input_match read the step trace', async () => {
    const r = await grade({
      op: 'and',
      checks: [
        { type: 'node_visited', nodeId: 'ask_order_id', visited: true },
        {
          type: 'node_input_match',
          nodeId: 'ask_order_id',
          path: 'reason',
          match: 'contains',
          value: 'missing id',
        },
      ],
    })
    expect(r.status).toBe('pass')
  })

  test('output_match with regex over the run output', async () => {
    const r = await grade({
      op: 'and',
      checks: [
        { type: 'output_match', path: 'message', match: 'regex', value: 'ETA' },
      ],
    })
    expect(r.status).toBe('pass')
  })

  test('binary checks never contribute a score (score is null with no judge)', async () => {
    const r = await grade({
      op: 'and',
      checks: [{ type: 'tool_called', toolId: 'issue_refund', called: true }],
    })
    expect(r.score).toBeNull()
  })
})

describe('gradeRow — AND/OR reduction', () => {
  const good = { type: 'tool_called', toolId: 'issue_refund', called: true } as const
  const bad = { type: 'tool_called', toolId: 'issue_refund', called: false } as const

  test('AND fails if any check fails', async () => {
    expect((await grade({ op: 'and', checks: [good, bad] })).status).toBe('fail')
  })
  test('OR passes if any check passes', async () => {
    expect((await grade({ op: 'or', checks: [good, bad] })).status).toBe('pass')
  })
  // A sample that asserts nothing is not a passing sample — it's an
  // unanswerable question, and it used to inflate every pass rate it sat in.
  test('an empty tree is an error, not a pass (nothing was asserted)', async () => {
    const r = await grade({ op: 'and', checks: [] })
    expect(r.status).toBe('error')
    expect(r.score).toBeNull()
    expect(r.checkResults).toEqual([])
    expect(r.error).toContain('no checks')
  })
  test('an empty OR tree is an error too', async () => {
    expect((await grade({ op: 'or', checks: [] })).status).toBe('error')
  })
})

// A judge model that returns a fixed verdict/reason as JSON (generateObject
// reads the text content as the object).
function judgeModel(verdict: JudgeVerdict) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ reason: `judged ${verdict}`, verdict }),
        },
      ],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }),
  })
}

// A judge that hands back `replies` in order, one per call, counting them. A
// reply that isn't the {reason, verdict} object makes generateObject throw
// NoObjectGeneratedError — the one failure the grader re-issues.
function sequencedJudge(replies: string[]) {
  const calls = { count: 0 }
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      const text = replies[calls.count] ?? replies[replies.length - 1] ?? ''
      calls.count += 1
      return {
        content: [{ type: 'text' as const, text }],
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      }
    },
  })
  return { model, calls }
}

// Like judgeModel, but captures the prompt the judge was actually handed, so a
// test can assert WHAT the judge saw (full output vs. a plucked field).
function capturingJudge(verdict: JudgeVerdict) {
  const seen: { prompt: string } = { prompt: '' }
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      seen.prompt = JSON.stringify(options.prompt)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ reason: `judged ${verdict}`, verdict }),
          },
        ],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      }
    },
  })
  return { model, seen }
}

describe('gradeRow — judge checks', () => {
  test('judge sees the FULL run output (no truncation), even when large', async () => {
    // A value far past the old 120-char cap must still reach the judge — this is
    // the regression guard for the truncated-judge-prompt bug.
    const tail = 'z'.repeat(500)
    const { model, seen } = capturingJudge('strong')
    await gradeRow({
      checks: { op: 'and', checks: [{ type: 'llm_judge', rubric: 'r' }] },
      steps: workflowSteps,
      output: { pad: tail, docMeta: { parties: ['Acme Corp'] } },
      getModel: () => model,
      defaultJudgeModelId: 'mock',
    })
    expect(seen.prompt).toContain('Acme Corp') // last field survives
    expect(seen.prompt).toContain(tail) // not chopped at 120 chars
  })

  test('llm_judge `path` pins the judge to one output value', async () => {
    const { model, seen } = capturingJudge('strong')
    const r = await gradeRow({
      checks: {
        op: 'and',
        checks: [
          { type: 'llm_judge', rubric: 'parties are present', path: 'docMeta.parties' },
        ],
      },
      steps: workflowSteps,
      output: {
        outline: [{ headerText: 'noise'.repeat(50) }],
        docMeta: { parties: ['Acme Corp', 'Beta LLC'] },
      },
      getModel: () => model,
      defaultJudgeModelId: 'mock',
    })
    expect(r.status).toBe('pass')
    expect(seen.prompt).toContain('docMeta.parties') // labeled with the path
    expect(seen.prompt).toContain('Beta LLC') // the plucked value is present
    expect(seen.prompt).not.toContain('outline') // unrelated fields are excluded
  })


  test('judge sees tool RESULTS (outputs), not just the calls — groundedness', async () => {
    // The retrieved context lives in a tool's OUTPUT. A judge grading
    // faithfulness must be shown it; this guards the fix that started passing
    // tool outputs (previously only `{ tool, args }` reached the judge).
    const { model, seen } = capturingJudge('strong')
    await gradeRow({
      checks: { op: 'and', checks: [{ type: 'llm_judge', rubric: 'grounded' }] },
      steps: [
        {
          nodeId: 'a',
          nodeKind: 'agent',
          output: { text: 'answer' },
          meta: {
            steps: [
              {
                stepNumber: 0,
                toolCalls: [
                  {
                    toolCallId: '1',
                    toolName: 'search_rag',
                    input: { query: 'statute of limitations' },
                    output: { chunks: ['SECRET_RETRIEVED_FACT'] },
                  },
                ],
              },
            ],
          },
        },
      ],
      output: { text: 'answer' },
      getModel: () => model,
      defaultJudgeModelId: 'mock',
    })
    expect(seen.prompt).toContain('SECRET_RETRIEVED_FACT') // the result reached the judge
  })

  test('synthesis mode: seeded tool calls are shown to the judge even with no run steps', async () => {
    // Under freezeTools the agent calls nothing, so the trace has no tool step.
    // The seeded context must still reach the judge for a groundedness rubric.
    const { model, seen } = capturingJudge('strong')
    await gradeRow({
      checks: { op: 'and', checks: [{ type: 'llm_judge', rubric: 'grounded' }] },
      steps: [{ nodeId: 'a', nodeKind: 'agent', output: { text: 'final reply' } }],
      output: { text: 'final reply' },
      seededToolCalls: [
        {
          toolId: 'search_rag',
          args: { query: 'filing deadline' },
          output: { chunks: ['SEEDED_CONTEXT_CHUNK'] },
        },
      ],
      getModel: () => model,
      defaultJudgeModelId: 'mock',
    })
    expect(seen.prompt).toContain('SEEDED_CONTEXT_CHUNK')
    expect(seen.prompt).toContain('filing deadline')
  })

  test('a verdict clearing the bar passes; score comes from the verdict', async () => {
    const r = await grade(
      {
        op: 'and',
        checks: [{ type: 'llm_judge', rubric: 'polite', bar: 'close_enough' }],
      },
      { getModel: () => judgeModel('strong'), defaultJudgeModelId: 'mock' },
    )
    expect(r.status).toBe('pass')
    expect(r.score).toBe(1)
    expect(r.checkResults[0]?.verdict).toBe('strong')
  })

  test('a verdict below the bar fails the row', async () => {
    const r = await grade(
      {
        op: 'and',
        checks: [{ type: 'llm_judge', rubric: 'polite', bar: 'nails_it' }],
      },
      { getModel: () => judgeModel('partial'), defaultJudgeModelId: 'mock' },
    )
    expect(r.status).toBe('fail')
    // Still scores 0.5 — the bar decides pass/fail, the verdict decides score.
    expect(r.score).toBe(0.5)
  })

  test('`close_enough` accepts `partial`; `score_only` never fails', async () => {
    const lenient = await grade(
      {
        op: 'and',
        checks: [{ type: 'llm_judge', rubric: 'polite', bar: 'close_enough' }],
      },
      { getModel: () => judgeModel('partial'), defaultJudgeModelId: 'mock' },
    )
    expect(lenient.status).toBe('pass')

    const scoreOnly = await grade(
      {
        op: 'and',
        checks: [{ type: 'llm_judge', rubric: 'polite', bar: 'score_only' }],
      },
      { getModel: () => judgeModel('weak'), defaultJudgeModelId: 'mock' },
    )
    // The weakest possible verdict, and the sample still passes — the score is
    // the only thing a `score_only` check moves.
    expect(scoreOnly.status).toBe('pass')
    expect(scoreOnly.score).toBe(0)
  })

  test('a LEGACY threshold maps to a bar by intent, not arithmetic', async () => {
    // 0.7 meant "clearly good, minor flaws OK" — a `partial` must keep passing
    // even though 0.5 < 0.7. Mapping the old number arithmetically would have
    // silently failed every saved check that used the default.
    const legacy = await grade(
      {
        op: 'and',
        checks: [{ type: 'llm_judge', rubric: 'polite', threshold: 0.7 }],
      },
      { getModel: () => judgeModel('partial'), defaultJudgeModelId: 'mock' },
    )
    expect(legacy.status).toBe('pass')

    const strict = await grade(
      {
        op: 'and',
        checks: [{ type: 'llm_judge', rubric: 'polite', threshold: 0.9 }],
      },
      { getModel: () => judgeModel('partial'), defaultJudgeModelId: 'mock' },
    )
    expect(strict.status).toBe('fail')
  })

  test('score is the WEIGHTED mean of judge checks, binary excluded', async () => {
    // `weight` is legacy and no longer authorable, but saved checks carry it.
    const verdicts: Record<string, JudgeVerdict> = { a: 'strong', b: 'weak' }
    const r = await grade(
      {
        op: 'or',
        checks: [
          { type: 'tool_called', toolId: 'issue_refund', called: true },
          { type: 'llm_judge', rubric: 'a', modelId: 'a', weight: 3 },
          { type: 'llm_judge', rubric: 'b', modelId: 'b', weight: 1 },
        ],
      },
      { getModel: (id) => judgeModel(verdicts[id] ?? 'weak') },
    )
    // (1*3 + 0*1) / 4 = 0.75
    expect(r.score).toBeCloseTo(0.75, 5)
  })

  test('AND: an errored judge with no definite failure leaves the row undecidable', async () => {
    const r = await grade(
      { op: 'and', checks: [{ type: 'llm_judge', rubric: 'x' }] },
      {
        getModel: () => {
          throw new Error('model down')
        },
        defaultJudgeModelId: 'mock',
      },
    )
    expect(r.status).toBe('error')
    expect(r.checkResults[0]?.reason).toContain('judge error')
    // The reason is lifted to the ROW so the report's banner can show it.
    expect(r.error).toContain('judge error')
  })

  // The headline fix: an errored judge is UNKNOWN, not false, so it can no
  // longer sink a row whose verdict another check already settled.
  test('OR: a definite pass survives a judge that blew up', async () => {
    const r = await grade(
      {
        op: 'or',
        checks: [
          { type: 'tool_called', toolId: 'issue_refund', called: true },
          { type: 'llm_judge', rubric: 'x' },
        ],
      },
      {
        getModel: () => {
          throw new Error('model down')
        },
        defaultJudgeModelId: 'mock',
      },
    )
    expect(r.status).toBe('pass')
    expect(r.error).toBeUndefined()
    expect(r.checkResults[1]?.reason).toContain('judge error')
  })

  test('AND: a definite failure decides the row before an unknown does', async () => {
    const r = await grade(
      {
        op: 'and',
        checks: [
          { type: 'tool_called', toolId: 'issue_refund', called: false },
          { type: 'llm_judge', rubric: 'x' },
        ],
      },
      {
        getModel: () => {
          throw new Error('model down')
        },
        defaultJudgeModelId: 'mock',
      },
    )
    expect(r.status).toBe('fail')
  })

  test('OR: nothing definite and an unknown → error', async () => {
    const r = await grade(
      {
        op: 'or',
        checks: [
          { type: 'tool_called', toolId: 'issue_refund', called: false },
          { type: 'llm_judge', rubric: 'x' },
        ],
      },
      {
        getModel: () => {
          throw new Error('model down')
        },
        defaultJudgeModelId: 'mock',
      },
    )
    expect(r.status).toBe('error')
  })

  test('an APICallError keeps its status code in the row error', async () => {
    const r = await grade(
      { op: 'and', checks: [{ type: 'llm_judge', rubric: 'x' }] },
      {
        getModel: () => {
          throw new APICallError({
            message: 'Bad Request',
            url: 'https://api.example.com/v1/chat',
            requestBodyValues: {},
            statusCode: 504,
          })
        },
        defaultJudgeModelId: 'mock',
      },
    )
    // `err.message` alone would have been the useless bare "Bad Request".
    expect(r.error).toContain('504')
  })

  test('a malformed judge response is re-issued once and can recover', async () => {
    const judge = sequencedJudge(['{ not json', JSON.stringify({ reason: 'ok', verdict: 'strong' })])
    const r = await grade(
      { op: 'and', checks: [{ type: 'llm_judge', rubric: 'x' }] },
      { getModel: () => judge.model, defaultJudgeModelId: 'mock' },
    )
    expect(r.status).toBe('pass')
    expect(judge.calls.count).toBe(2)
  })

  test('a persistently malformed judge stops at the attempt cap', async () => {
    const judge = sequencedJudge(['{ not json', '{ still not json'])
    const r = await grade(
      { op: 'and', checks: [{ type: 'llm_judge', rubric: 'x' }] },
      { getModel: () => judge.model, defaultJudgeModelId: 'mock' },
    )
    expect(r.status).toBe('error')
    // Exactly the cap — not a loop that keeps paying for a judge that can't answer.
    expect(judge.calls.count).toBe(2)
  })

  test('a non-NoObjectGenerated failure is NOT retried', async () => {
    let calls = 0
    const r = await grade(
      { op: 'and', checks: [{ type: 'llm_judge', rubric: 'x' }] },
      {
        getModel: () => {
          calls += 1
          throw new Error('model down')
        },
        defaultJudgeModelId: 'mock',
      },
    )
    expect(r.status).toBe('error')
    expect(calls).toBe(1)
  })

  test('missing judge model → error (no getModel wired)', async () => {
    const r = await grade({
      op: 'and',
      checks: [{ type: 'llm_judge', rubric: 'x' }],
    })
    expect(r.status).toBe('error')
  })
})

describe('rollup', () => {
  test('pass rate + judge-only mean score', () => {
    const out = rollup([
      { status: 'pass', score: 0.9 },
      { status: 'fail', score: 0.5 },
      { status: 'pass', score: null }, // no judge → excluded from mean
      { status: 'error', score: null },
    ])
    expect(out.total).toBe(4)
    expect(out.passed).toBe(2)
    expect(out.failed).toBe(2)
    expect(out.errored).toBe(1)
    expect(out.passRate).toBe(0.5)
    expect(out.meanScore).toBeCloseTo(0.7, 5) // mean of 0.9 and 0.5
  })

  test('no scored rows → meanScore null', () => {
    expect(rollup([{ status: 'pass', score: null }]).meanScore).toBeNull()
  })
})
