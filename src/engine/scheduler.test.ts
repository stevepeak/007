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
  config: { operator: 'is_not_empty' as const },
})

const output = (id: string) => ({
  id,
  kind: 'output' as const,
  position: pos(),
  label: id,
  config: {},
})

const race = (id: string) => ({
  id,
  kind: 'race' as const,
  position: pos(),
  label: id,
  config: {},
})

const aggregate = (id: string) => ({
  id,
  kind: 'aggregate' as const,
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

  test('a YES/NO agent routes its own yes/no edges like a branch', () => {
    // No branch node: the agent node itself carries conditioned yes/no edges
    // (as a boolean-output agent does) and reports 'no', so only the NO arm is
    // alive. Its own output still flows to that arm (unlike a branch, which
    // passes its input through).
    const s = new Scheduler({
      version: 1,
      nodes: [
        trigger('t'),
        agent('ask'),
        agent('yes'),
        agent('no'),
        output('o'),
      ],
      edges: [
        edge('t', 'ask'),
        edge('ask', 'yes', 'yes'),
        edge('ask', 'no', 'no'),
        edge('yes', 'o'),
        edge('no', 'o'),
      ],
    })
    s.seedTrigger({})
    const r = drive(s, (id) => {
      if (id === 'ask') {
        return { output: { answer: false, reason: 'nope' }, branchResult: 'no' }
      }
      return { output: { ran: id } }
    })
    expect(r.fired).toEqual(['ask', 'no'])
    expect(r.output).toEqual({ ran: 'no' })
  })

  test('a YES/NO agent forwards its {answer,reason} to the taken arm', () => {
    const s = new Scheduler({
      version: 1,
      nodes: [trigger('t'), agent('ask'), agent('yes'), output('o')],
      edges: [
        edge('t', 'ask'),
        edge('ask', 'yes', 'yes'),
        edge('yes', 'o'),
      ],
    })
    s.seedTrigger({})
    let armInput: unknown
    while (true) {
      const inst = s.next()
      if (inst.type !== 'execute') break
      if (inst.node.id === 'ask') {
        s.report(inst.node.id, {
          output: { answer: true, reason: 'yep' },
          branchResult: 'yes',
        })
      } else {
        armInput = inst.input
        s.report(inst.node.id, { output: {} })
      }
    }
    expect(armInput).toEqual({ answer: true, reason: 'yep' })
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

  // Drive a scheduler where a `race` node passes its resolved input straight
  // through (its real pass-through semantics), capturing what each race saw and
  // the terminal output. Non-race nodes emit `{ ran: id }`; a branch reports the
  // given decision.
  function driveWithRace(
    s: Scheduler,
    decisions: Record<string, 'yes' | 'no'> = {},
  ): {
    fired: string[]
    raceInputs: Record<string, unknown>
    outputNodeId?: string
    output?: unknown
  } {
    const fired: string[] = []
    const raceInputs: Record<string, unknown> = {}
    while (true) {
      const inst = s.next()
      if (inst.type === 'stall') throw new Error('stalled')
      if (inst.type === 'output') {
        return { fired, raceInputs, outputNodeId: inst.nodeId, output: inst.output }
      }
      fired.push(inst.node.id)
      if (inst.node.kind === 'race') {
        raceInputs[inst.node.id] = inst.input
        s.report(inst.node.id, { output: inst.input }) // pass-through
      } else if (inst.node.kind === 'branch') {
        s.report(inst.node.id, { output: {}, branchResult: decisions[inst.node.id] })
      } else {
        s.report(inst.node.id, { output: { ran: inst.node.id } })
      }
    }
  }

  test('a race fires on the first upstream and never waits for the others', () => {
    // `a` completes normally; the other input `c` sits behind the UNTAKEN arm of
    // a branch, so its edge into the race never goes alive. A normal all-inputs
    // join would stall forever; the race fires on `a` alone and passes it through.
    const s = new Scheduler({
      version: 1,
      nodes: [
        trigger('t'),
        agent('a'),
        branch('bn'),
        agent('c'),
        race('r'),
        output('o'),
      ],
      edges: [
        edge('t', 'a'),
        edge('t', 'bn'),
        edge('bn', 'c', 'no'), // only the NO arm is wired; the branch reports YES
        edge('a', 'r'),
        edge('c', 'r'),
        edge('r', 'o'),
      ],
    })
    s.seedTrigger({})
    const r = driveWithRace(s, { bn: 'yes' })
    expect(r.fired).not.toContain('c') // untaken arm — never ran
    expect(r.raceInputs.r).toEqual({ ran: 'a' }) // winner resolved as a single value
    expect(r.output).toEqual({ ran: 'a' }) // passed straight through to Output
    expect(r.outputNodeId).toBe('o')
  })

  test('a race with simultaneously-ready inputs takes the first in declaration order', () => {
    // Both `a` and `b` are always-live parallel producers, so both incoming
    // edges go alive together. The winner is deterministic: the first incoming
    // edge in declaration order (a→r before b→r), matching Output's tie-break.
    const s = new Scheduler({
      version: 1,
      nodes: [trigger('t'), agent('a'), agent('b'), race('r'), output('o')],
      edges: [
        edge('t', 'a'),
        edge('t', 'b'),
        edge('a', 'r'),
        edge('b', 'r'),
        edge('r', 'o'),
      ],
    })
    s.seedTrigger({})
    const r = driveWithRace(s)
    expect(r.raceInputs.r).toEqual({ ran: 'a' })
    expect(r.output).toEqual({ ran: 'a' })
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

  test('an aggregate collects every upstream output into an ordered list', () => {
    // Three always-live producers feed one aggregate. Unlike the default join
    // (which yields a {src: output} object), the aggregate resolves its input to
    // an ORDERED list — one element per producer, in edge-declaration order — and
    // fires only once ALL three have completed (default `every` readiness). The
    // list flows straight through to the Output.
    let aggInput: unknown
    let aggFiredAfter = 0
    let completed = 0
    const s = new Scheduler({
      version: 1,
      nodes: [
        trigger('t'),
        agent('a'),
        agent('b'),
        agent('c'),
        aggregate('agg'),
        output('o'),
      ],
      edges: [
        edge('t', 'a'),
        edge('t', 'b'),
        edge('t', 'c'),
        // Declaration order b, a, c → list order must follow the EDGES, not the
        // node order, proving the ordering comes from incoming-edge order.
        edge('b', 'agg'),
        edge('a', 'agg'),
        edge('c', 'agg'),
        edge('agg', 'o'),
      ],
    })
    s.seedTrigger({})
    let out: unknown
    while (true) {
      const inst = s.next()
      if (inst.type === 'output') {
        out = inst.output
        break
      }
      if (inst.type !== 'execute') throw new Error('unexpected stall')
      if (inst.node.id === 'agg') {
        aggInput = inst.input
        aggFiredAfter = completed
        // The aggregate passes its resolved list straight through (as the real
        // executor does), so the Output sees the collected list, not a fake value.
        s.report(inst.node.id, { output: inst.input })
        completed++
        continue
      }
      s.report(inst.node.id, { output: { ran: inst.node.id } })
      completed++
    }
    // Fired only after a, b, c (3 producers) all completed — not early like race.
    expect(aggFiredAfter).toBe(3)
    // One element per producer, in edge-declaration order (b, a, c).
    expect(aggInput).toEqual([{ ran: 'b' }, { ran: 'a' }, { ran: 'c' }])
    expect(out).toEqual([{ ran: 'b' }, { ran: 'a' }, { ran: 'c' }])
  })

  test('an aggregate with a single producer yields a one-element list', () => {
    // Degenerate but total: one producer in → a one-element list out (never the
    // bare value), so downstream `list` consumers always see an array.
    let aggInput: unknown
    const s = new Scheduler({
      version: 1,
      nodes: [trigger('t'), agent('a'), aggregate('agg'), output('o')],
      edges: [edge('t', 'a'), edge('a', 'agg'), edge('agg', 'o')],
    })
    s.seedTrigger({})
    while (true) {
      const inst = s.next()
      if (inst.type !== 'execute') break
      if (inst.node.id === 'agg') aggInput = inst.input
      s.report(inst.node.id, { output: { ran: inst.node.id } })
    }
    expect(aggInput).toEqual([{ ran: 'a' }])
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

  test('allows a work node downstream of a race that joined both branch arms', () => {
    // branch → yes:race, no:y → race, then race → join (a non-Output work node).
    // The race collapses the branch (fires on whichever arm is live, always
    // completes), so `join`'s all-incoming-alive rule is always satisfiable — it
    // must NOT be rejected as a both-arms stall, and must run under either arm.
    const build = () =>
      new Scheduler({
        version: 1,
        nodes: [
          trigger('t'),
          branch('b'),
          agent('y'),
          race('r'),
          agent('join'),
          output('o'),
        ],
        edges: [
          edge('t', 'b'),
          edge('b', 'r', 'yes'), // yes arm straight into the race
          edge('b', 'y', 'no'),
          edge('y', 'r'), // no arm into the race after work
          edge('r', 'join'),
          edge('join', 'o'),
        ],
      })
    expect(build).not.toThrow()
    for (const decision of ['yes', 'no'] as const) {
      const s = build()
      s.seedTrigger({})
      const r = drive(s, (id, kind) => ({
        output: { ran: id },
        branchResult: kind === 'branch' ? decision : undefined,
      }))
      expect(r.fired).toContain('join') // no stall — the join runs
      expect(r.outputNodeId).toBe('o')
    }
  })

  test('allows one work node fed by two independent branch-joining races', () => {
    // The real "Ingest document" shape: a producer fans into two branches, each
    // collapsed by its own race, and both races (plus the producer) converge on
    // one work node. Every race always completes, so the join is satisfiable.
    const build = () =>
      new Scheduler({
        version: 1,
        nodes: [
          trigger('t'),
          agent('p'), // producer feeding both branches + the join
          branch('b1'),
          agent('c1'),
          race('r1'),
          branch('b2'),
          agent('c2'),
          race('r2'),
          agent('save'),
          output('o'),
        ],
        edges: [
          edge('t', 'p'),
          edge('p', 'b1'),
          edge('b1', 'r1', 'yes'),
          edge('b1', 'c1', 'no'),
          edge('c1', 'r1'),
          edge('p', 'b2'),
          edge('b2', 'r2', 'yes'),
          edge('b2', 'c2', 'no'),
          edge('c2', 'r2'),
          edge('p', 'save'),
          edge('r1', 'save'),
          edge('r2', 'save'),
          edge('save', 'o'),
        ],
      })
    expect(build).not.toThrow()
    const s = build()
    s.seedTrigger({})
    const r = drive(s, (id, kind) => ({
      output: { ran: id },
      branchResult: kind === 'branch' ? ('no' as const) : undefined,
    }))
    expect(r.fired).toContain('save')
    expect(r.outputNodeId).toBe('o')
  })

  test('still rejects a work node when an arm bypasses the race', () => {
    // branch → yes:race→join, but no arm feeds `join` DIRECTLY (bypassing the
    // race). The direct no-arm edge keeps both arms in the join's cone, so it can
    // still stall — the race seal must not mask this real case.
    expect(
      () =>
        new Scheduler({
          version: 1,
          nodes: [
            trigger('t'),
            branch('b'),
            race('r'),
            agent('join'),
            output('o'),
          ],
          edges: [
            edge('t', 'b'),
            edge('b', 'r', 'yes'),
            edge('r', 'join'),
            edge('b', 'join', 'no'), // no arm bypasses the race
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
