import { describe, expect, test } from 'bun:test'

import type { Decider, DecisionNode, DecisionRequest } from '../graph'

import { executeDecisionNode } from './decision'

// The node's job is to turn authored questions into ONE provider call and a
// verdict per question. It does not route — a downstream Branch/Switch does — so
// what is pinned here is everything the provider cannot be trusted to do for us:
// batching into one call, rehydrating a spilled state before it is judged, and
// applying per-question thresholds.

function node(config: Partial<DecisionNode['config']> = {}): DecisionNode {
  return {
    id: 'judge',
    kind: 'decision',
    label: 'Judge',
    position: { x: 0, y: 0 },
    informUser: { mode: 'off' },
    config: {
      modelId: 'test:decider',
      questions: [
        { id: 'urgent', type: 'boolean', prompt: 'Urgent?', choices: [] },
      ],
      ...config,
    },
  }
}

/** Records what the node asked, and answers with a fixed probability. */
function stubDecider(
  probability = 0.9,
): { decide: Decider; calls: DecisionRequest[] } {
  const calls: DecisionRequest[] = []
  const decide: Decider = (request) => {
    calls.push(request)
    return Promise.resolve({
      modelId: 'test:decider@2026-09',
      answers: request.questions.map((q) =>
        q.type === 'boolean'
          ? { id: q.id, type: 'boolean' as const, probability }
          : {
              id: q.id,
              type: q.type,
              distribution: (q.type === 'category' ? q.options : q.levels).map(
                (c, i) => ({ key: c.key, probability: i === 0 ? 1 : 0 }),
              ),
            },
      ),
    })
  }
  return { decide, calls }
}

describe('executeDecisionNode', () => {
  test('asks every question in ONE provider call', async () => {
    const { decide, calls } = stubDecider()
    const r = await executeDecisionNode({
      node: node({
        questions: [
          { id: 'urgent', type: 'boolean', prompt: 'Urgent?', choices: [] },
          { id: 'legal', type: 'boolean', prompt: 'Legal?', choices: [] },
          {
            id: 'team',
            type: 'category',
            prompt: 'Whose?',
            choices: [{ key: 'a' }, { key: 'b' }],
          },
        ],
      }),
      input: 'a customer complaint',
      nodeOutputs: new Map(),
      getDecider: () => decide,
    })

    // Three gates for the price of one round trip — the reason this node exists
    // rather than three agent nodes.
    expect(calls).toHaveLength(1)
    expect(calls[0].questions.map((q) => q.id)).toEqual([
      'urgent',
      'legal',
      'team',
    ])
    expect(Object.keys(r.answers)).toEqual(['urgent', 'legal', 'team'])
  })

  test('rehydrates a spilled state before judging it', async () => {
    // Without this the provider is handed a blob POINTER and answers questions
    // about a JSON reference — confidently, and completely wrongly. A large
    // upstream output is exactly the kind of thing worth judging, so this is the
    // common case, not the edge case.
    const { decide, calls } = stubDecider()
    await executeDecisionNode({
      node: node(),
      input: { __blobRef: 'r2://docs/abc' },
      nodeOutputs: new Map(),
      getDecider: () => decide,
      rehydrate: () => Promise.resolve('the real extracted text'),
    })
    expect(calls[0].state).toBe('the real extracted text')
  })

  test('judges the `source` ref rather than whatever arrived', async () => {
    const { decide, calls } = stubDecider()
    await executeDecisionNode({
      node: node({ source: { kind: 'ref', nodeId: 'extract', path: 'text' } }),
      input: 'the wrong value',
      nodeOutputs: new Map([['extract', { text: 'the right value' }]]),
      getDecider: () => decide,
    })
    expect(calls[0].state).toBe('the right value')
  })

  test('applies each question its own threshold', async () => {
    // "Does this need a lawyer" and "is this spam" have no business sharing a
    // cut, so the threshold is per question and not per node.
    const { decide } = stubDecider(0.7)
    const r = await executeDecisionNode({
      node: node({
        questions: [
          {
            id: 'lenient',
            type: 'boolean',
            prompt: 'Urgent?',
            choices: [],
            threshold: 0.5,
          },
          {
            id: 'strict',
            type: 'boolean',
            prompt: 'Urgent?',
            choices: [],
            threshold: 0.95,
          },
        ],
      }),
      input: 'x',
      nodeOutputs: new Map(),
      getDecider: () => decide,
    })
    expect(r.answers.lenient).toMatchObject({ value: true })
    expect(r.answers.strict).toMatchObject({ value: false })
  })

  test('answers every question and reports no arm to route on', async () => {
    const { decide } = stubDecider(0.55)
    const r = await executeDecisionNode({
      node: node(),
      input: 'x',
      nodeOutputs: new Map(),
      getDecider: () => decide,
    })
    // The shape the node exists for: ask once, let several downstream Branches
    // read the answers, pay for one call instead of N. A low-confidence verdict
    // is still reported as what the model thought — `confidence` rides on the
    // answer, for a Branch to test if the author cares.
    expect(r.answers.urgent).toMatchObject({ value: true })
    expect(r.answers.urgent.confidence).toBeCloseTo(0.1)
    expect(r).not.toHaveProperty('result')
  })

  describe('choices bound to an upstream list', () => {
    /** A category question whose options come from node `src`'s output. */
    const bound = (path = 'items') =>
      node({
        questions: [
          {
            id: 'which',
            type: 'category' as const,
            prompt: 'Which one?',
            choices: [],
            choicesSource: { kind: 'ref' as const, nodeId: 'src', path },
          },
        ],
      })

    const outputs = (items: unknown) => new Map([['src', { items }]])

    test('turns the upstream array into the options the provider is asked about', async () => {
      const { decide, calls } = stubDecider()
      await executeDecisionNode({
        node: bound(),
        input: 'x',
        nodeOutputs: outputs(['lease', 'invoice']),
        getDecider: () => decide,
      })
      const asked = calls[0]?.questions[0]
      expect(asked?.type === 'category' && asked.options.map((o) => o.key)).toEqual([
        'lease',
        'invoice',
      ])
    })

    test('reads objects by key or label, carrying the description', async () => {
      const { decide, calls } = stubDecider()
      await executeDecisionNode({
        node: bound(),
        input: 'x',
        nodeOutputs: outputs([
          { key: 'a', description: 'The lease' },
          { label: 'Invoice 42' },
        ]),
        getDecider: () => decide,
      })
      const asked = calls[0]?.questions[0]
      expect(asked?.type === 'category' && asked.options).toEqual([
        { key: 'a', description: 'The lease' },
        { key: 'Invoice 42', description: undefined },
      ])
    })

    test('the authored list is ignored while a binding is set', async () => {
      const { decide, calls } = stubDecider()
      await executeDecisionNode({
        node: node({
          questions: [
            {
              id: 'which',
              type: 'category',
              prompt: 'Which one?',
              choices: [{ key: 'stale_a' }, { key: 'stale_b' }],
              choicesSource: { kind: 'ref', nodeId: 'src', path: 'items' },
            },
          ],
        }),
        input: 'x',
        nodeOutputs: outputs(['live_a', 'live_b']),
        getDecider: () => decide,
      })
      const asked = calls[0]?.questions[0]
      expect(asked?.type === 'category' && asked.options.map((o) => o.key)).toEqual([
        'live_a',
        'live_b',
      ])
    })

    test('rehydrates a spilled list before judging it', async () => {
      const { decide, calls } = stubDecider()
      await executeDecisionNode({
        node: bound(),
        input: 'x',
        nodeOutputs: outputs({ $spill: 'r2://items' }),
        getDecider: () => decide,
        rehydrate: (v) =>
          Promise.resolve(
            (v as { $spill?: string }).$spill ? ['one', 'two'] : v,
          ),
      })
      const asked = calls[0]?.questions[0]
      expect(asked?.type === 'category' && asked.options.map((o) => o.key)).toEqual([
        'one',
        'two',
      ])
    })

    test('refuses a list that is not a list, is too short, or repeats itself', async () => {
      const { decide } = stubDecider()
      const run = (items: unknown) =>
        executeDecisionNode({
          node: bound(),
          input: 'x',
          nodeOutputs: outputs(items),
          getDecider: () => decide,
        })

      await expect(run('lease, invoice')).rejects.toThrow('not a list')
      await expect(run(['only one'])).rejects.toThrow(
        'arrived with 1 — it needs at least two',
      )
      await expect(run(['same', 'same'])).rejects.toThrow("'same' twice")
      await expect(run([{ description: 'no name' }, 'b'])).rejects.toThrow(
        'no key or label at position 1',
      )
    })
  })

  test('chunks past the provider batch limit, sequentially', async () => {
    const { decide, calls } = stubDecider()
    const limited: Decider = Object.assign(
      (req: DecisionRequest) => decide(req),
      { maxQuestionsPerCall: 2 },
    )
    const r = await executeDecisionNode({
      node: node({
        questions: ['a', 'b', 'c'].map((id) => ({
          id,
          type: 'boolean' as const,
          prompt: 'Go?',
          choices: [],
        })),
      }),
      input: 'x',
      nodeOutputs: new Map(),
      getDecider: () => limited,
    })
    expect(calls.map((c) => c.questions.map((q) => q.id))).toEqual([
      ['a', 'b'],
      ['c'],
    ])
    expect(Object.keys(r.answers)).toEqual(['a', 'b', 'c'])
  })

  test('records the model that actually answered, not the floating id asked for', async () => {
    const { decide } = stubDecider()
    const r = await executeDecisionNode({
      node: node(),
      input: 'x',
      nodeOutputs: new Map(),
      getDecider: () => decide,
    })
    expect(r.modelId).toBe('test:decider@2026-09')
  })

  test('refuses a node with no model or no questions', async () => {
    const { decide } = stubDecider()
    const run = (config: Partial<DecisionNode['config']>) =>
      executeDecisionNode({
        node: node(config),
        input: 'x',
        nodeOutputs: new Map(),
        getDecider: () => decide,
      })

    await expect(run({ modelId: '' })).rejects.toThrow(
      'no decision model selected',
    )
    await expect(run({ questions: [] })).rejects.toThrow('asks no questions')
  })

  test('refuses a choice question with too few options, before calling out', async () => {
    let called = false
    const decide: Decider = () => {
      called = true
      return Promise.resolve({ answers: [] })
    }
    await expect(
      executeDecisionNode({
        node: node({
          questions: [
            {
              id: 'team',
              type: 'category',
              prompt: 'Whose?',
              choices: [{ key: 'only' }],
            },
          ],
        }),
        input: 'x',
        nodeOutputs: new Map(),
        getDecider: () => decide,
      }),
    ).rejects.toThrow('needs at least two')
    expect(called).toBe(false)
  })

  test('refuses a question with no prompt', async () => {
    const { decide } = stubDecider()
    await expect(
      executeDecisionNode({
        node: node({
          questions: [
            { id: 'urgent', type: 'boolean', prompt: '  ', choices: [] },
          ],
        }),
        input: 'x',
        nodeOutputs: new Map(),
        getDecider: () => decide,
      }),
    ).rejects.toThrow('has no prompt')
  })
})
