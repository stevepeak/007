import { describe, expect, test } from 'bun:test'

import { Scheduler } from './scheduler'
import { aggregate, agent, branch, edge, output, race, trigger } from './scheduler-test-helpers'

describe('Scheduler', () => {
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
})
