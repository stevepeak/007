import { describe, expect, test } from 'bun:test'

import type { DecisionVerdict } from '../engine/decision'
import type { CheckTree } from '../engine/eval-schema'

import { gradeRow } from './grade'

// The `decision_answers` check: the whole matrix graded as one row, with no
// judge and no provider call. What it has to get right is the difference
// between a wrong ANSWER and a right answer the sample wasn't sure enough
// about — which is the tolerance the per-question `output_match` fallback
// could never express.

function tree(check: unknown): CheckTree {
  return { op: 'and', checks: [check] } as CheckTree
}

function boolean(id: string, probability: number, threshold = 0.5): DecisionVerdict {
  return {
    id,
    type: 'boolean',
    value: probability >= threshold,
    probability,
    threshold,
    confidence: Math.abs(probability - 0.5) * 2,
    distribution: [
      { key: 'yes', probability },
      { key: 'no', probability: 1 - probability },
    ],
  }
}

function category(id: string, value: string, probability: number): DecisionVerdict {
  return {
    id,
    type: 'category',
    value,
    confidence: 0.3,
    distribution: [
      { key: value, probability },
      { key: 'other', probability: 1 - probability },
    ],
  }
}

function output (answers: Record<string, DecisionVerdict>, verdict = 'escalate') {
  return {
  verdict,
  because: 'rule 1',
  answers,
}
}

describe('decision_answers', () => {
  test('passes when the verdict and every expected answer match', async () => {
    const result = await gradeRow({
      checks: tree({
        type: 'decision_answers',
        verdict: 'escalate',
        expect: [
          { questionId: 'is_urgent', yes: true },
          { questionId: 'matter', key: 'billing' },
        ],
      }),
      steps: [],
      output: output({
        is_urgent: boolean('is_urgent', 0.82),
        matter: category('matter', 'billing', 0.7),
      }),
    })
    expect(result.status).toBe('pass')
    // No judge ran, so there is nothing to score — a decision Goal's report is
    // pass rate, not a quality float.
    expect(result.score).toBeNull()
  })

  test('names EVERY mismatch, not just the first', async () => {
    // A matrix that got three of five wrong should say which three in one
    // read — the next edit is to the questions.
    const result = await gradeRow({
      checks: tree({
        type: 'decision_answers',
        verdict: 'escalate',
        expect: [
          { questionId: 'is_urgent', yes: true },
          { questionId: 'matter', key: 'billing' },
        ],
      }),
      steps: [],
      output: output(
        {
          is_urgent: boolean('is_urgent', 0.1),
          matter: category('matter', 'outage', 0.9),
        },
        'auto_reply',
      ),
    })
    expect(result.status).toBe('fail')
    const reason = result.checkResults[0]?.reason ?? ''
    expect(reason).toContain('verdict expected escalate')
    expect(reason).toContain('is_urgent expected yes')
    expect(reason).toContain('matter expected billing')
  })

  test('a right answer below the sample’s tolerance is a fail, and says so', async () => {
    const result = await gradeRow({
      checks: tree({
        type: 'decision_answers',
        expect: [{ questionId: 'is_urgent', yes: true, minProbability: 0.7 }],
      }),
      steps: [],
      output: output({ is_urgent: boolean('is_urgent', 0.55) }),
    })
    expect(result.status).toBe('fail')
    expect(result.checkResults[0]?.reason).toContain('below the 0.7')
  })

  test('a tolerance on an expected NO reads the probability of no', async () => {
    // "no with p(yes)=0.05" is a confident no — reading `probability` raw
    // would call it 0.05 and fail a sample that is as certain as they come.
    const result = await gradeRow({
      checks: tree({
        type: 'decision_answers',
        expect: [{ questionId: 'is_urgent', yes: false, minProbability: 0.9 }],
      }),
      steps: [],
      output: output({ is_urgent: boolean('is_urgent', 0.05) }),
    })
    expect(result.status).toBe('pass')
  })

  test('grading the verdict alone is allowed — questions settle before rules', async () => {
    const result = await gradeRow({
      checks: tree({ type: 'decision_answers', verdict: 'escalate', expect: [] }),
      steps: [],
      output: output({ is_urgent: boolean('is_urgent', 0.9) }),
    })
    expect(result.status).toBe('pass')
  })

  test('an unanswered question is a fail, not a silent pass', async () => {
    const result = await gradeRow({
      checks: tree({
        type: 'decision_answers',
        expect: [{ questionId: 'renamed_since', yes: true }],
      }),
      steps: [],
      output: output({ is_urgent: boolean('is_urgent', 0.9) }),
    })
    expect(result.status).toBe('fail')
    expect(result.checkResults[0]?.reason).toContain('was not answered')
  })

  test('an output that is not a decision result says so rather than failing blankly', async () => {
    // What a check authored against a decision agent does when its Goal is
    // repointed at a generation one.
    const result = await gradeRow({
      checks: tree({ type: 'decision_answers', verdict: 'escalate', expect: [] }),
      steps: [],
      output: { text: 'I think you should escalate this.' },
    })
    expect(result.status).toBe('fail')
    expect(result.checkResults[0]?.reason).toContain('no decision answers')
  })
})
