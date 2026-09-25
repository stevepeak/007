import { describe, expect, test } from 'bun:test'

import {
  chunkQuestions,
  distributionConfidence,
  resolveVerdict,
  resolveVerdicts,
  type CategoryQuestion,
  type DecisionQuestion,
  type ScaleQuestion,
} from './decision'

// `decision.ts` is where a provider's probabilities become a routing decision,
// which makes it the file where a quiet bug routes real work down the wrong arm.
// These tests pin the four properties that keep the seam portable:
//   • confidence means ONE thing across providers and question types;
//   • a scale's index follows the QUESTION's level order, not the answer's;
//   • a provider that under-reports its distribution can't shift the result;
//   • a missing or mistyped answer fails loudly rather than routing as `false`.

const boolQ: DecisionQuestion = {
  id: 'urgent',
  type: 'boolean',
  prompt: 'Urgent?',
}

const catQ: CategoryQuestion = {
  id: 'team',
  type: 'category',
  prompt: 'Which team?',
  options: [
    { key: 'billing' },
    { key: 'technical' },
    { key: 'sales' },
  ],
}

const scaleQ: ScaleQuestion = {
  id: 'heat',
  type: 'scale',
  prompt: 'How hot?',
  levels: [{ key: 'calm' }, { key: 'annoyed' }, { key: 'furious' }],
}

describe('distributionConfidence', () => {
  test('is the margin between the top two probabilities', () => {
    expect(
      distributionConfidence([
        { key: 'a', probability: 0.7 },
        { key: 'b', probability: 0.2 },
        { key: 'c', probability: 0.1 },
      ]),
    ).toBeCloseTo(0.5)
  })

  test('reads a near-tie as unsure even though the top probability is healthy', () => {
    // The whole reason for margin over top-probability. A 0.51/0.49 split has a
    // perfectly respectable-looking 0.51 on top and is a coin flip.
    expect(
      distributionConfidence([
        { key: 'a', probability: 0.51 },
        { key: 'b', probability: 0.49 },
      ]),
    ).toBeCloseTo(0.02)
  })

  test('agrees with the binary special case, so one threshold means one thing', () => {
    // For {yes: p, no: 1-p} the margin is |p - (1-p)| = |p - 0.5| * 2. This
    // identity is why a confidence floor authored on a boolean question still
    // means the same thing when the question becomes a category.
    for (const p of [0.93, 0.5, 0.05, 1, 0]) {
      expect(
        distributionConfidence([
          { key: 'yes', probability: p },
          { key: 'no', probability: 1 - p },
        ]),
      ).toBeCloseTo(Math.abs(p - 0.5) * 2)
    }
  })

  test('a single-key distribution has no runner-up and scores 1', () => {
    expect(distributionConfidence([{ key: 'only', probability: 1 }])).toBe(1)
  })
})

describe('resolveVerdict — boolean', () => {
  test('applies the caller threshold, not the provider probability', () => {
    // The point of the split: the provider never sees the cut, so raising it
    // changes the verdict without changing the answer.
    const answer = { id: 'urgent', type: 'boolean' as const, probability: 0.7 }
    expect(resolveVerdict(boolQ, answer, { threshold: 0.5 })).toMatchObject({
      value: true,
      threshold: 0.5,
    })
    expect(resolveVerdict(boolQ, answer, { threshold: 0.9 })).toMatchObject({
      value: false,
      threshold: 0.9,
    })
  })

  test('defaults to 0.5 and records the threshold it used', () => {
    const v = resolveVerdict(boolQ, {
      id: 'urgent',
      type: 'boolean',
      probability: 0.5,
    })
    // `>=`, so exactly-at-threshold is a yes — and the trace says which cut ran.
    expect(v).toMatchObject({ value: true, threshold: 0.5 })
  })

  test('prefers a provider confidence over the derived margin', () => {
    const v = resolveVerdict(boolQ, {
      id: 'urgent',
      type: 'boolean',
      probability: 0.7,
      confidence: 0.42,
    })
    expect(v.confidence).toBe(0.42)
  })
})

describe('resolveVerdict — category', () => {
  test('picks the highest-probability option', () => {
    const v = resolveVerdict(catQ, {
      id: 'team',
      type: 'category',
      distribution: [
        { key: 'billing', probability: 0.6 },
        { key: 'technical', probability: 0.3 },
        { key: 'sales', probability: 0.1 },
      ],
    })
    expect(v).toMatchObject({ value: 'billing' })
    expect(v.confidence).toBeCloseTo(0.3)
  })

  test('fills options the provider left out with zero', () => {
    // A provider reporting only what it considered plausible would otherwise
    // leave a two-entry distribution for a three-option question — and the
    // confidence margin would be measured against a runner-up that isn't there.
    const v = resolveVerdict(catQ, {
      id: 'team',
      type: 'category',
      distribution: [{ key: 'billing', probability: 1 }],
    })
    expect(v.distribution).toEqual([
      { key: 'billing', probability: 1 },
      { key: 'technical', probability: 0 },
      { key: 'sales', probability: 0 },
    ])
    expect(v.confidence).toBe(1)
  })
})

describe('resolveVerdict — scale', () => {
  test('weights the index by probability rather than taking the mode', () => {
    // The reason `scale` exists at all: "mostly furious, a bit annoyed" is 1.84,
    // which is a different fact from "furious".
    const v = resolveVerdict(scaleQ, {
      id: 'heat',
      type: 'scale',
      distribution: [
        { key: 'calm', probability: 0 },
        { key: 'annoyed', probability: 0.16 },
        { key: 'furious', probability: 0.84 },
      ],
    })
    expect(v).toMatchObject({ level: 'furious' })
    expect(v.type === 'scale' && v.value).toBeCloseTo(1.84)
  })

  test('indexes by the QUESTION order, not the order the provider answered in', () => {
    // A provider is free to return its distribution in any order. Indexing by
    // arrival would produce a plausible number that is simply wrong — this is
    // the bug the alignment step exists to make impossible.
    const shuffled = resolveVerdict(scaleQ, {
      id: 'heat',
      type: 'scale',
      distribution: [
        { key: 'furious', probability: 0.84 },
        { key: 'calm', probability: 0 },
        { key: 'annoyed', probability: 0.16 },
      ],
    })
    expect(shuffled.type === 'scale' && shuffled.value).toBeCloseTo(1.84)
    expect(shuffled).toMatchObject({ level: 'furious' })
  })

  test('normalizes a distribution that does not sum to 1', () => {
    const v = resolveVerdict(scaleQ, {
      id: 'heat',
      type: 'scale',
      distribution: [
        { key: 'calm', probability: 0.2 },
        { key: 'annoyed', probability: 0.2 },
        { key: 'furious', probability: 0.2 },
      ],
    })
    expect(v.type === 'scale' && v.value).toBeCloseTo(1)
  })
})

describe('resolveVerdicts', () => {
  test('throws on a question the provider did not answer', () => {
    // Silently skipping it would leave a routing read of `undefined`, and
    // `undefined >= 0.5` is false — the node would route "no" with total
    // confidence having been told nothing.
    expect(() =>
      resolveVerdicts([boolQ, catQ], [
        { id: 'urgent', type: 'boolean', probability: 0.9 },
      ]),
    ).toThrow("did not answer question 'team'")
  })

  test('throws when an answer type does not match the question', () => {
    expect(() =>
      resolveVerdicts([boolQ], [
        {
          id: 'urgent',
          type: 'category',
          distribution: [{ key: 'a', probability: 1 }],
        },
      ]),
    ).toThrow("asked as 'boolean' but answered as 'category'")
  })
})

describe('chunkQuestions', () => {
  test('is a single chunk when the provider declares no cap', () => {
    expect(chunkQuestions([boolQ, catQ, scaleQ], undefined)).toHaveLength(1)
  })

  test('splits past the cap, preserving order', () => {
    const chunks = chunkQuestions([boolQ, catQ, scaleQ], 2)
    expect(chunks.map((c) => c.map((q) => q.id))).toEqual([
      ['urgent', 'team'],
      ['heat'],
    ])
  })
})
