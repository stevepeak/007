import { describe, expect, test } from 'bun:test'

import { createAssessTool, assess, type AssessArgs } from './decision-tool'
import type { Decider, DecisionRequest } from './decision'

// The tool stands between a MODEL-authored question and the SDK's decision
// contract. The input schema can't express "choice needs options" (no `oneOf`
// under the strict dialect), so these tests pin the hand-rolled checks that
// replace it — and pin that a bad question never reaches the provider, since a
// round trip there costs money and tells the model less.
//
// Nothing here knows of any vendor. Translating the contract into a provider's
// wire format is the host's adapter, and its own tests cover that; the point of
// the split is that there is exactly one such translation per provider.

/** Records what was asked, and answers every question in the contract's shape. */
function stubDecider(): { decide: Decider; calls: DecisionRequest[] } {
  const calls: DecisionRequest[] = []
  const decide: Decider = (request) => {
    calls.push(request)
    return Promise.resolve({
      modelId: 'test:decider',
      answers: request.questions.map((q) => {
        if (q.type === 'boolean') {
          return { id: q.id, type: 'boolean' as const, probability: 0.88 }
        }
        const choices = q.type === 'category' ? q.options : q.levels
        return {
          id: q.id,
          type: q.type,
          // Weight the LAST choice, so a scale's index is visibly non-zero and
          // an answer that ignored the question's order would show up.
          distribution: choices.map((c, i) => ({
            key: c.key,
            probability:
              i === choices.length - 1 ? 0.9 : 0.1 / (choices.length - 1),
          })),
          confidence: 0.8,
        }
      }),
    })
  }
  return { decide, calls }
}

/** No decider should be reached at all. */
const forbidDecider: Decider = () => {
  throw new Error('the provider was called')
}

const ARGS: AssessArgs = {
  state: 'Client asks whether they can terminate the lease early.',
  questions: [
    { id: 'needs_lawyer', type: 'yes_no', instructions: 'Needs review?' },
    {
      id: 'area',
      type: 'choice',
      instructions: 'Which practice area?',
      options: [
        { key: 'property', meaning: 'Leases, land, conveyancing' },
        { key: 'employment', meaning: 'Contracts of employment' },
      ],
    },
    {
      id: 'sensitivity',
      type: 'score',
      instructions: 'How sensitive?',
      levels: ['routine', 'sensitive', 'urgent'],
    },
  ],
}

describe('assess', () => {
  test('answers every question in one request, flattened for the agent', async () => {
    const { decide, calls } = stubDecider()

    const result = await assess(ARGS, decide)

    expect(calls).toHaveLength(1)
    expect(result.error).toBeUndefined()
    expect(result.answers).toEqual([
      {
        id: 'needs_lawyer',
        type: 'yes_no',
        // |0.88 - 0.5| * 2 — the engine's margin, not a second definition.
        confidence: expect.closeTo(0.76, 5) as number,
        probability: 0.88,
      },
      {
        id: 'area',
        type: 'choice',
        confidence: 0.8,
        choice: 'employment',
        options: [
          { key: 'property', probability: expect.closeTo(0.1, 5) as number },
          { key: 'employment', probability: 0.9 },
        ],
      },
      {
        id: 'sensitivity',
        type: 'score',
        confidence: 0.8,
        score: expect.closeTo(1.85, 2) as number,
        label: 'urgent',
      },
    ])
  })

  test('builds contract questions, naming no vendor', async () => {
    const { decide, calls } = stubDecider()

    await assess(ARGS, decide)

    expect(calls[0].questions).toEqual([
      { id: 'needs_lawyer', type: 'boolean', prompt: 'Needs review?' },
      {
        id: 'area',
        type: 'category',
        prompt: 'Which practice area?',
        options: [
          { key: 'property', description: 'Leases, land, conveyancing' },
          { key: 'employment', description: 'Contracts of employment' },
        ],
      },
      {
        id: 'sensitivity',
        type: 'scale',
        prompt: 'How sensitive?',
        // The model authored these as plain strings, so the label IS the key —
        // it is the one that reads the answer back.
        levels: [{ key: 'routine' }, { key: 'sensitive' }, { key: 'urgent' }],
      },
    ])
    expect(calls[0].state).toBe(ARGS.state)
  })

  test('rejects a choice with no options before touching the provider', async () => {
    const result = await assess(
      {
        state: 'x',
        questions: [
          { id: 'area', type: 'choice', instructions: 'Which?', options: [] },
        ],
      },
      forbidDecider,
    )

    expect(result.answers).toEqual([])
    expect(result.error).toContain("question 'area' is type 'choice'")
  })

  test('rejects a score with fewer than two levels before touching the provider', async () => {
    const result = await assess(
      {
        state: 'x',
        questions: [
          { id: 's', type: 'score', instructions: 'How bad?', levels: ['bad'] },
        ],
      },
      forbidDecider,
    )

    expect(result.error).toContain("question 's' is type 'score'")
  })

  test('rejects duplicate question ids, which would silently lose an answer', async () => {
    // Answers are keyed by id, so two questions sharing one id collapse into
    // one — the agent would get a single answer where it asked two, with
    // nothing anywhere saying so.
    const result = await assess(
      {
        state: 'x',
        questions: [
          { id: 'q', type: 'yes_no', instructions: 'A?' },
          { id: 'q', type: 'yes_no', instructions: 'B?' },
        ],
      },
      forbidDecider,
    )

    expect(result.error).toContain("Duplicate question id 'q'")
  })

  test('rejects duplicate option keys within one choice', async () => {
    const result = await assess(
      {
        state: 'x',
        questions: [
          {
            id: 'area',
            type: 'choice',
            instructions: 'Which?',
            options: [
              { key: 'a', meaning: 'first' },
              { key: 'a', meaning: 'second' },
            ],
          },
        ],
      },
      forbidDecider,
    )

    expect(result.error).toContain('duplicate option keys')
  })

  test('caps the question count and the state size', async () => {
    const many = await assess(
      {
        state: 'x',
        questions: Array.from({ length: 21 }, (_, i) => ({
          id: `q${i}`,
          type: 'yes_no' as const,
          instructions: 'Go?',
        })),
      },
      forbidDecider,
    )
    expect(many.error).toContain('Too many questions (21)')

    const big = await assess(
      { state: 'x'.repeat(120_001), questions: ARGS.questions },
      forbidDecider,
    )
    expect(big.error).toContain('too long')
  })

  test('reports a provider failure to the agent instead of throwing', async () => {
    // A thrown tool error ends the generation. "I could not get a judgment" is
    // something the agent can reason around — answer conservatively, escalate.
    const failing: Decider = () =>
      Promise.reject(new Error('Venice /decisions failed: 500 Rate limited'))

    const result = await assess(ARGS, failing)

    expect(result.answers).toEqual([])
    expect(result.error).toContain('Assessment failed')
    expect(result.error).toContain('500')
  })

  test('reports a provider that skipped a question rather than answering short', async () => {
    // `resolveVerdicts` throws on a missing answer; the tool turns that into
    // something the agent can act on. Silently dropping it would hand back a
    // list one shorter than the one asked for.
    const partial: Decider = (request) =>
      Promise.resolve({
        answers: [
          {
            id: request.questions[0].id,
            type: 'boolean' as const,
            probability: 0.9,
          },
        ],
      })

    const result = await assess(ARGS, partial)
    expect(result.error).toContain("did not answer question 'area'")
  })

  test('refuses an empty question list', async () => {
    const result = await assess(
      { state: 'x', questions: [] },
      forbidDecider,
    )
    expect(result.error).toBe('Ask at least one question.')
  })

  test('reaches the decider through the host deps accessor', async () => {
    // The seam that lets an SDK tool use a host resource: `build` is handed only
    // TDeps, so the decider has to come out of the deps bundle rather than from
    // `WfSdkConfig.getDecider` (which needs a RunContext `build` never sees).
    const { decide, calls } = stubDecider()
    const entry = createAssessTool<{ decide: Decider }>({
      getDecider: (d) => d.decide,
    })
    expect(entry.id).toBe('assess')
    expect(entry.origin).toBe('sdk')

    const built = entry.kind === 'ai-tool' ? entry.build({ decide }) : null
    await built?.execute?.(
      { state: 'x', questions: [ARGS.questions[0]] },
      { toolCallId: 't', messages: [], context: undefined },
    )
    expect(calls).toHaveLength(1)
  })
})
