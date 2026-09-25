import { describe, expect, test } from 'bun:test'

import type { Decider, DecisionRequest } from '../engine/decision'

import type { CheckTree } from './checks'
import { gradeRow } from './grade'

// `decision_judge` grades with a probability instead of prose, so what matters
// here is that the AUTHOR's threshold is what decides — not the provider's — and
// that the probability survives to the stored result, where it is the whole
// reason to prefer this over an LLM judge.

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
        rubric: 'The answer cites the governing statute.',
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
        defaultDecisionModelId: 'test:decider',
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
      defaultDecisionModelId: 'test:decider',
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
      defaultDecisionModelId: 'test:decider',
    })
    expect(graded.checkResults[0].probability).toBe(0.52)
    expect(graded.checkResults[0].reason).toContain('p=0.52')
  })

  test('reports confidence on the same 0..10 axis as the LLM judge', async () => {
    // p=0.52 is a near-coin-flip → margin 0.04 → 0/10. The two judge families
    // have to share the axis, or the report shows two numbers that look alike
    // and mean different things.
    const { decide } = stubDecider(0.52)
    const graded = await gradeRow({
      checks: tree(),
      steps: [],
      output: 'x',
      getDecider: () => decide,
      defaultDecisionModelId: 'test:decider',
    })
    expect(graded.checkResults[0].confidence).toBe(0)

    const { decide: sure } = stubDecider(0.99)
    const confident = await gradeRow({
      checks: tree(),
      steps: [],
      output: 'x',
      getDecider: () => sure,
      defaultDecisionModelId: 'test:decider',
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
      defaultDecisionModelId: 'test:decider',
    })
    expect(calls[0].questions).toEqual([
      {
        id: 'passes',
        type: 'boolean',
        prompt: 'The answer cites the governing statute.',
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
      checks: tree({ path: 'docMeta.parties' }),
      steps: [],
      output: { docMeta: { parties: ['Acme', 'Beta'] } },
      getDecider: () => decide,
      defaultDecisionModelId: 'test:decider',
    })
    expect(calls[0].state).toMatchObject({
      output: ['Acme', 'Beta'],
      outputPath: 'docMeta.parties',
    })
  })

  test('counts toward the row score like any other judge', async () => {
    const { decide } = stubDecider(0.9)
    const graded = await gradeRow({
      checks: tree(),
      steps: [],
      output: 'x',
      getDecider: () => decide,
      defaultDecisionModelId: 'test:decider',
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
})
