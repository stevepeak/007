import { describe, expect, test } from 'bun:test'

import { Scheduler } from './scheduler'
import { agent, branch, drive, edge, output, trigger } from './scheduler-test-helpers'

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
})
