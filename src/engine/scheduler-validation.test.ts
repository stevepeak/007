import { describe, expect, test } from 'bun:test'

import { Scheduler } from './scheduler'
import { agent, branch, drive, edge, output, race, trigger } from './scheduler-test-helpers'

describe('Scheduler', () => {
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
})
