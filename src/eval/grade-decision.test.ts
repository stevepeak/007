import { describe, expect, test } from 'bun:test'

import type { Decider, DecisionRequest } from '../engine/decision'
import type { CheckTree } from '../engine/eval-schema'

import { gradeRow } from './grade'

// `decision_judge` grades with a probability instead of prose, so what matters
// here is that the AUTHOR's threshold is what decides — not the provider's —
// that the probability survives to the stored result, and that a row's judges
// are asked together.

/** Answers every boolean question with a fixed probability. */
function stubDecider(probability: number): {
  decide: Decider
  calls: DecisionRequest[]
} {
  const calls: DecisionRequest[] = []
  const decide: Decider = (request) => {
    calls.push(request)
    return Promise.resolve({
      modelId: 'test:decider',
      answers: request.questions.map((q) => ({
        id: q.id,
        type: 'boolean' as const,
        probability,
      })),
    })
  }
  return { decide, calls }
}

function tree(check: Partial<Record<string, unknown>> = {}): CheckTree {
  return {
    op: 'and',
    checks: [
      {
        type: 'decision_judge',
        rubric: 'The answer cites the governing policy.',
        ...check,
      },
    ],
  }
}

describe('decision_judge', () => {
  test('passes or fails on the check threshold, not the provider', async () => {
    // The same answer, two thresholds, two verdicts. This is the split the whole
    // decision seam is built around: the provider reports, the author decides.
    for (const [threshold, pass] of [
      [0.5, true],
      [0.9, false],
    ] as const) {
      const { decide } = stubDecider(0.7)
      const graded = await gradeRow({
        checks: tree({ threshold }),
        steps: [],
        output: 'some answer',
        getDecider: () => decide,
        decisionJudgeModelId: 'test:decider',
      })
      expect(graded.checkResults[0].pass).toBe(pass)
    }
  })

  test('defaults to 0.5 when the check names no threshold', async () => {
    const { decide } = stubDecider(0.51)
    const graded = await gradeRow({
      checks: tree(),
      steps: [],
      output: 'x',
      getDecider: () => decide,
      decisionJudgeModelId: 'test:decider',
    })
    expect(graded.checkResults[0].pass).toBe(true)
  })

  test('keeps the raw probability on the result', async () => {
    // 0.52 and 0.99 are both a pass; only one is worth a second look. Folding
    // the number into the boolean would throw away the reason to use a
    // calibrated judge at all.
    const { decide } = stubDecider(0.52)
    const graded = await gradeRow({
      checks: tree(),
      steps: [],
      output: 'x',
      getDecider: () => decide,
      decisionJudgeModelId: 'test:decider',
    })
    expect(graded.checkResults[0].probability).toBe(0.52)
    expect(graded.checkResults[0].reason).toContain('p(yes)=0.52')
  })

  test('reports confidence on the stored 0..10 axis', async () => {
    // p=0.52 is a near-coin-flip → margin 0.04 → 0/10.
    const { decide } = stubDecider(0.52)
    const graded = await gradeRow({
      checks: tree(),
      steps: [],
      output: 'x',
      getDecider: () => decide,
      decisionJudgeModelId: 'test:decider',
    })
    expect(graded.checkResults[0].confidence).toBe(0)

    const { decide: sure } = stubDecider(0.99)
    const confident = await gradeRow({
      checks: tree(),
      steps: [],
      output: 'x',
      getDecider: () => sure,
      decisionJudgeModelId: 'test:decider',
    })
    expect(confident.checkResults[0].confidence).toBe(10)
  })

  test('puts the rubric to the decider as the question itself', async () => {
    const { decide, calls } = stubDecider(0.9)
    await gradeRow({
      checks: tree(),
      steps: [],
      output: { answer: 'cites s.21' },
      getDecider: () => decide,
      decisionJudgeModelId: 'test:decider',
    })
    expect(calls[0].questions).toEqual([
      {
        id: 'c0',
        type: 'boolean',
        prompt: 'The answer cites the governing policy.',
      },
    ])
    expect(calls[0].state).toMatchObject({
      output: { answer: 'cites s.21' },
      outputPath: null,
    })
  })

  test('grades only the pinned path when the check names one', async () => {
    const { decide, calls } = stubDecider(0.9)
    await gradeRow({
      checks: tree({ path: 'docMeta.recipients' }),
      steps: [],
      output: { docMeta: { recipients: ['Acme', 'Beta'] } },
      getDecider: () => decide,
      decisionJudgeModelId: 'test:decider',
    })
    expect(calls[0].state).toMatchObject({
      output: ['Acme', 'Beta'],
      outputPath: 'docMeta.recipients',
    })
  })

  test('counts toward the row score like any other judge', async () => {
    const { decide } = stubDecider(0.9)
    const graded = await gradeRow({
      checks: tree(),
      steps: [],
      output: 'x',
      getDecider: () => decide,
      decisionJudgeModelId: 'test:decider',
    })
    expect(graded.score).toBe(1)
    expect(graded.status).toBe('pass')
  })

  test('reports a host with no decision provider as a check error, not a crash', async () => {
    const graded = await gradeRow({
      checks: tree(),
      steps: [],
      output: 'x',
    })
    // The row errors rather than throwing, so the grid shows a cell that
    // explains itself instead of the whole sweep falling over.
    expect(graded.status).toBe('error')
    expect(graded.checkResults[0].reason).toContain('getDecider')
  })

  test('asks every judge of a row in ONE request', async () => {
    const { decide, calls } = stubDecider(0.8)
    const graded = await gradeRow({
      checks: {
        op: 'and',
        checks: [
          { type: 'decision_judge', rubric: 'Is it polite?' },
          { type: 'tool_called', toolId: 't', called: false },
          { type: 'decision_judge', rubric: 'Is it correct?' },
        ],
      },
      steps: [],
      output: 'x',
      getDecider: () => decide,
      decisionJudgeModelId: 'test:decider',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].questions.map((q) => q.prompt)).toEqual([
      'Is it polite?',
      'Is it correct?',
    ])
    // Results stay aligned with the checks they grade.
    expect(graded.checkResults.map((r) => r.probability)).toEqual([
      0.8,
      undefined,
      0.8,
    ])
  })

  test('one request per output path, and per question cap', async () => {
    const { decide, calls } = stubDecider(0.8)
    const capped = Object.assign(decide, { maxQuestionsPerCall: 1 })
    await gradeRow({
      checks: {
        op: 'and',
        checks: [
          { type: 'decision_judge', rubric: 'a' },
          { type: 'decision_judge', rubric: 'b' },
          { type: 'decision_judge', rubric: 'c', path: 'title' },
        ],
      },
      steps: [],
      output: { title: 'T' },
      getDecider: () => capped,
      decisionJudgeModelId: 'test:decider',
    })
    expect(calls).toHaveLength(3)
  })

  test('a failed request errors only the checks it carried', async () => {
    const decide: Decider = (request) => {
      if (request.state && (request.state as { outputPath: unknown }).outputPath) {
        return Promise.reject(new Error('provider down'))
      }
      return Promise.resolve({
        answers: request.questions.map((q) => ({
          id: q.id,
          type: 'boolean' as const,
          probability: 0.9,
        })),
      })
    }
    const graded = await gradeRow({
      checks: {
        op: 'or',
        checks: [
          { type: 'decision_judge', rubric: 'a' },
          { type: 'decision_judge', rubric: 'b', path: 'title' },
        ],
      },
      steps: [],
      output: { title: 'T' },
      getDecider: () => decide,
      decisionJudgeModelId: 'test:decider',
    })
    expect(graded.checkResults[0].pass).toBe(true)
    expect(graded.checkResults[1].reason).toContain('provider down')
    // OR: a definite pass survives a judge that blew up.
    expect(graded.status).toBe('pass')
  })

  test('AND: an errored judge with no definite failure leaves the row undecidable', async () => {
    const graded = await gradeRow({
      checks: {
        op: 'and',
        checks: [
          { type: 'tool_called', toolId: 't', called: false },
          { type: 'decision_judge', rubric: 'a' },
        ],
      },
      steps: [],
      output: 'x',
      getDecider: () => () => Promise.reject(new Error('timeout')),
      decisionJudgeModelId: 'test:decider',
    })
    expect(graded.status).toBe('error')
    expect(graded.error).toContain('timeout')
    expect(graded.score).toBeNull()
  })

  test('score is the judge pass rate, binary checks excluded', async () => {
    const decide: Decider = (request) => {
      return Promise.resolve({
        answers: request.questions.map((q, i) => ({
          id: q.id,
          type: 'boolean' as const,
          probability: i === 0 ? 0.9 : 0.1,
        })),
      })
    }
    const graded = await gradeRow({
      checks: {
        op: 'or',
        checks: [
          { type: 'tool_called', toolId: 't', called: false },
          { type: 'decision_judge', rubric: 'a' },
          { type: 'decision_judge', rubric: 'b' },
        ],
      },
      steps: [],
      output: 'x',
      getDecider: () => decide,
      decisionJudgeModelId: 'test:decider',
    })
    expect(graded.score).toBe(0.5)
  })

  test('category: p is the mass on the expected options', async () => {
    const { calls, decide } = distributionDecider([
      { key: 'friendly', probability: 0.35 },
      { key: 'neutral', probability: 0.3 },
      { key: 'defensive', probability: 0.35 },
    ])
    const graded = await gradeRow({
      checks: tree({
        answer: 'category',
        choices: ['friendly', 'neutral', 'defensive'],
        expected: ['friendly', 'neutral'],
      }),
      steps: [],
      output: 'x',
      getDecider: () => decide,
      decisionJudgeModelId: 'test:decider',
    })
    expect(calls[0].questions[0]).toMatchObject({ type: 'category' })
    expect(graded.checkResults[0].probability).toBeCloseTo(0.65)
    expect(graded.checkResults[0].pass).toBe(true)
    expect(graded.checkResults[0].reason).toContain('p(friendly | neutral)')
  })

  test('scale: p is the mass at or above minLevel', async () => {
    const { decide } = distributionDecider([
      { key: 'poor', probability: 0.2 },
      { key: 'fair', probability: 0.4 },
      { key: 'good', probability: 0.3 },
      { key: 'excellent', probability: 0.1 },
    ])
    const graded = await gradeRow({
      checks: tree({
        answer: 'scale',
        choices: ['poor', 'fair', 'good', 'excellent'],
        minLevel: 'good',
      }),
      steps: [],
      output: 'x',
      getDecider: () => decide,
      decisionJudgeModelId: 'test:decider',
    })
    expect(graded.checkResults[0].probability).toBeCloseTo(0.4)
    expect(graded.checkResults[0].pass).toBe(false)
  })

  test('a category with no expected option is that check\'s error', async () => {
    const { decide, calls } = stubDecider(0.9)
    const graded = await gradeRow({
      checks: tree({ answer: 'category', choices: ['a', 'b'] }),
      steps: [],
      output: 'x',
      getDecider: () => decide,
      decisionJudgeModelId: 'test:decider',
    })
    expect(calls).toHaveLength(0)
    expect(graded.status).toBe('error')
    expect(graded.checkResults[0].reason).toContain('no expected option')
  })

  test('a legacy llm_judge is graded as a yes/no decision judge', async () => {
    const { decide, calls } = stubDecider(0.9)
    const graded = await gradeRow({
      checks: {
        op: 'and',
        checks: [{ type: 'llm_judge', rubric: 'Is it right?' } as never],
      },
      steps: [],
      output: 'x',
      getDecider: () => decide,
      decisionJudgeModelId: 'test:decider',
    })
    expect(calls[0].questions[0]).toMatchObject({
      type: 'boolean',
      prompt: 'Is it right?',
    })
    expect(graded.status).toBe('pass')
  })
})

/** Answers every category/scale question with a fixed distribution. */
function distributionDecider(
  distribution: { key: string; probability: number }[],
): { decide: Decider; calls: DecisionRequest[] } {
  const calls: DecisionRequest[] = []
  const decide: Decider = (request) => {
    calls.push(request)
    return Promise.resolve({
      answers: request.questions.map((q) => ({
        id: q.id,
        type: q.type as 'category',
        distribution,
      })),
    })
  }
  return { decide, calls }
}
