import { describe, expect, test } from 'bun:test'

import { Scheduler, WorkflowBudgetError } from './scheduler'

// ---------------------------------------------------------------------------
// Minimal node/edge builders. We lean on workflowGraphSchema defaults (applied
// inside the Scheduler constructor) so each builder only sets what a test
// actually cares about.
// ---------------------------------------------------------------------------

let seq = 0
const pos = () => ({ x: (seq += 10), y: 0 })

const trigger = (id: string) => ({
  id,
  kind: 'trigger' as const,
  position: pos(),
  label: id,
  config: { triggerKind: 'chat_message' },
})

const agent = (id: string) => ({
  id,
  kind: 'agent' as const,
  position: pos(),
  label: id,
  config: { agentId: 'agent-1' },
})

const branch = (id: string) => ({
  id,
  kind: 'branch' as const,
  position: pos(),
  label: id,
  config: { path: '', operator: 'is_not_empty' as const },
})

const output = (id: string) => ({
  id,
  kind: 'output' as const,
  position: pos(),
  label: id,
  config: {},
})

const edge = (
  source: string,
  target: string,
  condition: 'yes' | 'no' | null = null,
) => ({
  id: `${source}->${target}:${condition ?? ''}`,
  source,
  target,
  condition,
})

/** Drive a scheduler to completion, executing each node via `run`. */
function drive(
  s: Scheduler,
  run: (
    nodeId: string,
    kind: string,
  ) => {
    output: unknown
    branchResult?: 'yes' | 'no'
  },
): { fired: string[]; outputNodeId: string; output: unknown } {
  const fired: string[] = []
  while (true) {
    const inst = s.next()
    if (inst.type === 'stall') {
      throw new Error('stalled')
    }
    if (inst.type === 'output') {
      return { fired, outputNodeId: inst.nodeId, output: inst.output }
    }
    fired.push(inst.node.id)
    s.report(inst.node.id, run(inst.node.id, inst.node.kind))
  }
}

describe('Scheduler', () => {
  test('linear graph runs trigger → agent → output and forwards output', () => {
    const s = new Scheduler({
      version: 1,
      nodes: [trigger('t'), agent('a'), output('o')],
      edges: [edge('t', 'a'), edge('a', 'o')],
    })
    s.seedTrigger({ userText: 'hi' })
    const r = drive(s, (id) => ({ output: { ran: id } }))
    expect(r.fired).toEqual(['a'])
    expect(r.outputNodeId).toBe('o')
    expect(r.output).toEqual({ ran: 'a' })
  })

  test('branch routes to the YES arm and ignores the NO arm', () => {
    const s = new Scheduler({
      version: 1,
      nodes: [
        trigger('t'),
        branch('b'),
        agent('yes'),
        agent('no'),
        output('o'),
      ],
      edges: [
        edge('t', 'b'),
        edge('b', 'yes', 'yes'),
        edge('b', 'no', 'no'),
        edge('yes', 'o'),
        edge('no', 'o'),
      ],
    })
    s.seedTrigger({})
    const r = drive(s, (id, kind) =>
      kind === 'branch'
        ? { output: { branched: true }, branchResult: 'yes' }
        : { output: { ran: id } },
    )
    expect(r.fired).toEqual(['b', 'yes'])
    expect(r.output).toEqual({ ran: 'yes' })
  })

  test('branch routes to the NO arm', () => {
    const s = new Scheduler({
      version: 1,
      nodes: [
        trigger('t'),
        branch('b'),
        agent('yes'),
        agent('no'),
        output('o'),
      ],
      edges: [
        edge('t', 'b'),
        edge('b', 'yes', 'yes'),
        edge('b', 'no', 'no'),
        edge('yes', 'o'),
        edge('no', 'o'),
      ],
    })
    s.seedTrigger({})
    const r = drive(s, (id, kind) =>
      kind === 'branch'
        ? { output: {}, branchResult: 'no' }
        : { output: { ran: id } },
    )
    expect(r.fired).toEqual(['b', 'no'])
    expect(r.output).toEqual({ ran: 'no' })
  })

  test('branch passes its input straight through as its output', () => {
    const s = new Scheduler({
      version: 1,
      nodes: [
        trigger('t'),
        branch('b'),
        agent('yes'),
        agent('no'),
        output('o'),
      ],
      edges: [
        edge('t', 'b'),
        edge('b', 'yes', 'yes'),
        edge('b', 'no', 'no'),
        edge('yes', 'o'),
        edge('no', 'o'),
      ],
    })
    s.seedTrigger({ seed: 1 })
    // The branch sees the trigger output as its input; we mirror the executor
    // contract by reporting that same input as the branch's output.
    let agentInput: unknown
    while (true) {
      const inst = s.next()
      if (inst.type !== 'execute') break
      if (inst.node.kind === 'branch') {
        expect(inst.input).toEqual({ seed: 1 })
        s.report(inst.node.id, { output: inst.input, branchResult: 'yes' })
      } else {
        agentInput = inst.input
        s.report(inst.node.id, { output: {} })
      }
    }
    expect(agentInput).toEqual({ seed: 1 })
  })

  test('multiple arms converge on a single Output (first live edge wins)', () => {
    // Two branch arms both feed one Output node — the classic convergence the
    // engine supports today. Exactly one incoming edge is live.
    const s = new Scheduler({
      version: 1,
      nodes: [
        trigger('t'),
        branch('b'),
        agent('yes'),
        agent('no'),
        output('o'),
      ],
      edges: [
        edge('t', 'b'),
        edge('b', 'yes', 'yes'),
        edge('b', 'no', 'no'),
        edge('yes', 'o'),
        edge('no', 'o'),
      ],
    })
    s.seedTrigger({})
    const r = drive(s, (id, kind) =>
      kind === 'branch'
        ? { output: {}, branchResult: 'no' }
        : { output: { ran: id } },
    )
    expect(r.outputNodeId).toBe('o')
    expect(r.output).toEqual({ ran: 'no' })
  })

  test('multi-predecessor node receives an object keyed by source id', () => {
    // A node fed by two always-live predecessors gets {src: output} so it can
    // disambiguate. (No branch in between — both edges stay alive.)
    let joinInput: unknown
    const s2 = new Scheduler({
      version: 1,
      nodes: [trigger('t'), agent('a'), agent('b'), agent('join'), output('o')],
      edges: [
        edge('t', 'a'),
        edge('t', 'b'),
        edge('a', 'join'),
        edge('b', 'join'),
        edge('join', 'o'),
      ],
    })
    s2.seedTrigger({})
    while (true) {
      const inst = s2.next()
      if (inst.type !== 'execute') break
      if (inst.node.id === 'join') {
        joinInput = inst.input
      }
      s2.report(inst.node.id, { output: { ran: inst.node.id } })
    }
    expect(joinInput).toEqual({ a: { ran: 'a' }, b: { ran: 'b' } })
  })

  test('stalls when a node depends on an unreachable predecessor', () => {
    // `dangling` has no incoming edges and is not the trigger, so it never
    // becomes ready; `join` requires it, so the Output is never reachable.
    const s = new Scheduler({
      version: 1,
      nodes: [
        trigger('t'),
        agent('a'),
        agent('dangling'),
        agent('join'),
        output('o'),
      ],
      edges: [
        edge('t', 'a'),
        edge('a', 'join'),
        edge('dangling', 'join'),
        edge('join', 'o'),
      ],
    })
    s.seedTrigger({})
    // Run the one reachable node, then expect a stall.
    const first = s.next()
    expect(first.type).toBe('execute')
    if (first.type === 'execute') {
      s.report(first.node.id, { output: {} })
    }
    expect(s.next().type).toBe('stall')
  })

  test('rejects a work node that joins mutually-exclusive branch arms', () => {
    // branch → yes:x, no:y, then x & y both feed a non-Output `join`. Only one
    // arm ever runs, so the join's all-incoming-alive rule can never be met —
    // it would stall. Validation should reject it at construction.
    expect(
      () =>
        new Scheduler({
          version: 1,
          nodes: [
            trigger('t'),
            branch('b'),
            agent('x'),
            agent('y'),
            agent('join'),
            output('o'),
          ],
          edges: [
            edge('t', 'b'),
            edge('b', 'x', 'yes'),
            edge('b', 'y', 'no'),
            edge('x', 'join'),
            edge('y', 'join'),
            edge('join', 'o'),
          ],
        }),
    ).toThrow(/joins both arms/)
  })

  test('allows a work node that joins parallel paths on the same branch arm', () => {
    // branch → no arm → x, which fans out to p & q (both on the SAME arm) that
    // converge on a non-Output `join`. Both are alive together whenever `no` is
    // taken, so the all-incoming-alive rule is satisfiable — must be accepted.
    const s = new Scheduler({
      version: 1,
      nodes: [
        trigger('t'),
        branch('b'),
        agent('x'),
        agent('p'),
        agent('q'),
        agent('join'),
        output('o'),
        output('oyes'),
      ],
      edges: [
        edge('t', 'b'),
        edge('b', 'x', 'no'),
        edge('b', 'oyes', 'yes'), // yes arm routes to its own Output
        edge('x', 'p'),
        edge('x', 'q'),
        edge('p', 'join'),
        edge('q', 'join'),
        edge('join', 'o'),
      ],
    })
    s.seedTrigger({})
    const r = drive(s, (id, kind) => ({
      output: { ran: id },
      branchResult: kind === 'branch' ? ('no' as const) : undefined,
    }))
    expect(r.fired).toContain('join')
    expect(r.outputNodeId).toBe('o')
  })

  test('rejects an Output that merges parallel (non-branch) paths', () => {
    // trigger fans out to a & c, both feeding one Output. Both edges are always
    // live, so one arm's result would be silently dropped. Validation rejects it.
    expect(
      () =>
        new Scheduler({
          version: 1,
          nodes: [trigger('t'), agent('a'), agent('c'), output('o')],
          edges: [
            edge('t', 'a'),
            edge('t', 'c'),
            edge('a', 'o'),
            edge('c', 'o'),
          ],
        }),
    ).toThrow(/parallel paths/)
  })

  test('still accepts branch arms converging on a single Output', () => {
    expect(
      () =>
        new Scheduler({
          version: 1,
          nodes: [
            trigger('t'),
            branch('b'),
            agent('yes'),
            agent('no'),
            output('o'),
          ],
          edges: [
            edge('t', 'b'),
            edge('b', 'yes', 'yes'),
            edge('b', 'no', 'no'),
            edge('yes', 'o'),
            edge('no', 'o'),
          ],
        }),
    ).not.toThrow()
  })

  test('still accepts parallel fan-in to a non-Output join (no branch)', () => {
    expect(
      () =>
        new Scheduler({
          version: 1,
          nodes: [
            trigger('t'),
            agent('a'),
            agent('b'),
            agent('join'),
            output('o'),
          ],
          edges: [
            edge('t', 'a'),
            edge('t', 'b'),
            edge('a', 'join'),
            edge('b', 'join'),
            edge('join', 'o'),
          ],
        }),
    ).not.toThrow()
  })

  test('nextBatch returns every ready sibling as one antichain batch', () => {
    // trigger fans out to a & b (independent), which converge on join. The
    // first batch must contain BOTH siblings; join only becomes ready once both
    // are reported.
    const s = new Scheduler({
      version: 1,
      nodes: [trigger('t'), agent('a'), agent('b'), agent('join'), output('o')],
      edges: [
        edge('t', 'a'),
        edge('t', 'b'),
        edge('a', 'join'),
        edge('b', 'join'),
        edge('join', 'o'),
      ],
    })
    s.seedTrigger({})

    const first = s.nextBatch()
    expect(first.type).toBe('execute')
    if (first.type === 'execute') {
      expect(first.nodes.map((n) => n.node.id).sort()).toEqual(['a', 'b'])
      for (const n of first.nodes) {
        s.report(n.node.id, { output: { ran: n.node.id } })
      }
    }

    const second = s.nextBatch()
    expect(second.type).toBe('execute')
    if (second.type === 'execute') {
      expect(second.nodes.map((n) => n.node.id)).toEqual(['join'])
      // join sees both predecessors keyed by source id.
      expect(second.nodes[0].input).toEqual({
        a: { ran: 'a' },
        b: { ran: 'b' },
      })
      s.report('join', { output: {} })
    }

    expect(s.nextBatch().type).toBe('output')
  })

  test('a batch dispatches sibling nodes concurrently (they overlap)', async () => {
    const s = new Scheduler({
      version: 1,
      nodes: [trigger('t'), agent('a'), agent('b'), agent('join'), output('o')],
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

    // Minimal batch driver mirroring the executor/graph-workflow loop.
    while (true) {
      const inst = s.nextBatch()
      if (inst.type === 'output') break
      if (inst.type === 'stall') throw new Error('stalled')
      const settled = await Promise.all(
        inst.nodes.map(async (n) => ({
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
