import { describe, expect, test } from 'bun:test'

import { Scheduler, WorkflowBudgetError } from './scheduler'
import { agent, drive, edge, output, trigger } from './scheduler-test-helpers'

describe('Scheduler', () => {
  test('takeReady returns every ready sibling as one antichain claim', () => {
    // trigger fans out to a & b (independent), which converge on join. The
    // first claim must contain BOTH siblings; join only becomes ready once both
    // are reported.
    const s = new Scheduler({
      version: 1,
      nodes: [trigger('t'), agent('a'), agent('b'), agent('join'), output('o', 'join')],
      edges: [
        edge('t', 'a'),
        edge('t', 'b'),
        edge('a', 'join'),
        edge('b', 'join'),
        edge('join', 'o'),
      ],
    })
    s.seedTrigger({})

    const first = s.takeReady()
    expect(first.map((n) => n.node.id).sort()).toEqual(['a', 'b'])
    expect(s.pollOutput()).toBeUndefined()
    for (const n of first) {
      s.report(n.node.id, { output: { ran: n.node.id } })
    }

    const second = s.takeReady()
    expect(second.map((n) => n.node.id)).toEqual(['join'])
    // join sees both predecessors keyed by source id.
    expect(second[0].input).toEqual({ a: { ran: 'a' }, b: { ran: 'b' } })
    s.report('join', { output: {} })

    expect(s.pollOutput()?.nodeId).toBe('o')
  })

  test('a claim dispatches sibling nodes concurrently (they overlap)', async () => {
    const s = new Scheduler({
      version: 1,
      nodes: [trigger('t'), agent('a'), agent('b'), agent('join'), output('o', 'join')],
      edges: [
        edge('t', 'a'),
        edge('t', 'b'),
        edge('a', 'join'),
        edge('b', 'join'),
        edge('join', 'o'),
      ],
    })
    s.seedTrigger({})

    // Barrier: a runner blocks until BOTH siblings have started. Serial
    // execution would deadlock (the first runner waits forever for a second
    // that never starts); only genuine overlap lets both proceed.
    let started = 0
    let release!: () => void
    const bothStarted = new Promise<void>((r) => (release = r))
    const overlap: string[] = []

    const run = async (id: string): Promise<{ output: unknown }> => {
      overlap.push(id)
      started += 1
      if (started === 2) release()
      await bothStarted
      return { output: { ran: id } }
    }

    // Minimal driver mirroring the executor/graph-workflow loop.
    while (!s.pollOutput()) {
      const claimed = s.takeReady()
      if (claimed.length === 0) throw new Error('stalled')
      const settled = await Promise.all(
        claimed.map(async (n) => ({
          id: n.node.id,
          result: await run(n.node.id),
        })),
      )
      for (const x of settled) s.report(x.id, x.result)
    }

    expect(overlap.slice(0, 2).sort()).toEqual(['a', 'b'])
  })

  test('enforces the node budget on a very long chain', () => {
    const N = 300
    const nodes = [
      trigger('t'),
      ...Array.from({ length: N }, (_, i) => agent(`a${i}`)),
      output('o'),
    ]
    const edges = [
      edge('t', 'a0'),
      ...Array.from({ length: N - 1 }, (_, i) => edge(`a${i}`, `a${i + 1}`)),
      edge(`a${N - 1}`, 'o'),
    ]
    const s = new Scheduler({ version: 1, nodes, edges })
    s.seedTrigger({})
    expect(() => drive(s, (id) => ({ output: { ran: id } }))).toThrow(
      WorkflowBudgetError,
    )
  })
})
