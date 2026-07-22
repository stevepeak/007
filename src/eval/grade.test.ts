import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, test } from 'bun:test'

import type { CheckTree } from './checks'
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
  test('an empty tree passes (nothing asserted)', async () => {
    expect((await grade({ op: 'and', checks: [] })).status).toBe('pass')
  })
})

// A judge model that returns a fixed score/reason as JSON (generateObject reads
// the text content as the object).
function judgeModel(score: number) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [
        { type: 'text', text: JSON.stringify({ score, reason: `scored ${score}` }) },
      ],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }),
  })
}

// Like judgeModel, but captures the prompt the judge was actually handed, so a
// test can assert WHAT the judge saw (full output vs. a plucked field).
function capturingJudge(score: number) {
  const seen: { prompt: string } = { prompt: '' }
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      seen.prompt = JSON.stringify(options.prompt)
      return {
        content: [
          { type: 'text', text: JSON.stringify({ score, reason: `scored ${score}` }) },
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
    const { model, seen } = capturingJudge(0.9)
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
    const { model, seen } = capturingJudge(0.9)
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


  test('judge score ≥ threshold passes; score comes from judge only', async () => {
    const r = await grade(
      {
        op: 'and',
        checks: [{ type: 'llm_judge', rubric: 'polite', threshold: 0.7 }],
      },
      { getModel: () => judgeModel(0.9), defaultJudgeModelId: 'mock' },
    )
    expect(r.status).toBe('pass')
    expect(r.score).toBe(0.9)
    expect(r.checkResults[0]?.reason).toContain('0.9')
  })

  test('judge score < threshold fails the row', async () => {
    const r = await grade(
      {
        op: 'and',
        checks: [{ type: 'llm_judge', rubric: 'polite', threshold: 0.7 }],
      },
      { getModel: () => judgeModel(0.55), defaultJudgeModelId: 'mock' },
    )
    expect(r.status).toBe('fail')
    expect(r.score).toBe(0.55)
  })

  test('score is the WEIGHTED mean of judge checks, binary excluded', async () => {
    const models: Record<string, number> = { a: 0.8, b: 0.4 }
    const r = await grade(
      {
        op: 'or',
        checks: [
          { type: 'tool_called', toolId: 'issue_refund', called: true },
          { type: 'llm_judge', rubric: 'a', modelId: 'a', weight: 3 },
          { type: 'llm_judge', rubric: 'b', modelId: 'b', weight: 1 },
        ],
      },
      { getModel: (id) => judgeModel(models[id] ?? 0) },
    )
    // (0.8*3 + 0.4*1) / 4 = 0.7
    expect(r.score).toBeCloseTo(0.7, 5)
  })

  test('a judge error marks the whole row status = error', async () => {
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
