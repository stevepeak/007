import { describe, expect, test } from 'bun:test'

import { Scheduler } from './scheduler'
import { agent, edge, output, race, trigger } from './scheduler-test-helpers'

// The rolling-walk half of the Scheduler: claiming ready nodes without a
// barrier, and the bookkeeping that makes that safe.
describe('Scheduler — rolling dispatch', () => {
  // trigger fans out to the answer arm and to a background arm nothing waits on.
  //   t → answer → o
  //   t → side
  const fanOut = () =>
    new Scheduler({
      version: 1,
      // `side` declared first, so declaration order alone would put it ahead.
      nodes: [trigger('t'), agent('side'), agent('answer'), output('o', 'answer')],
      edges: [edge('t', 'side'), edge('t', 'answer'), edge('answer', 'o')],
    })

  test('takeReady puts answer-critical nodes ahead of background ones', () => {
    const s = fanOut()
    s.seedTrigger({})
    expect(s.takeReady().map((i) => i.node.id)).toEqual(['answer', 'side'])
  })

  test('a claimed node is not handed out again', () => {
    const s = fanOut()
    s.seedTrigger({})
    expect(s.takeReady()).toHaveLength(2)
    // Nothing reported yet — under the old barrier contract the caller simply
    // never asked, so re-selection was impossible. Now it must be prevented.
    expect(s.takeReady()).toEqual([])
  })

  test('the Output is visible as soon as its own arm reports', () => {
    const s = fanOut()
    s.seedTrigger({})
    s.takeReady()
    expect(s.pollOutput()).toBeUndefined()

    // `side` is still in flight — the answer must not wait on it.
    s.report('answer', { output: { text: 'hi' } })
    expect(s.pollOutput()).toEqual({
      type: 'output',
      nodeId: 'o',
      output: { text: 'hi' },
    })
  })

  test('pendingWork counts nodes that are running, not just ready', () => {
    const s = fanOut()
    s.seedTrigger({})
    s.takeReady()
    s.report('answer', { output: { text: 'hi' } })

    // At the moment the answer is delivered, `side` is RUNNING. Nothing is
    // *ready*, so the old ready-only predicate would have said "nothing left"
    // and settled the run `completed` mid-flight.
    expect(s.hasReadyWork()).toBe(false)
    expect(s.hasPendingWork()).toBe(true)
    expect(s.inFlightCount()).toBe(1)

    s.report('side', { output: {} })
    expect(s.hasPendingWork()).toBe(false)
  })

  test('an abandoned node leaves flight without reviving or advancing its arm', () => {
    const s = new Scheduler({
      version: 1,
      nodes: [trigger('t'), agent('a'), agent('after'), output('o', 'after')],
      edges: [edge('t', 'a'), edge('a', 'after'), edge('after', 'o')],
    })
    s.seedTrigger({})
    expect(s.takeReady().map((i) => i.node.id)).toEqual(['a'])

    s.abandon('a')
    // Not re-selectable...
    expect(s.takeReady()).toEqual([])
    // ...not completed either, so `after` never becomes ready off a node that
    // produced nothing...
    expect(s.pollOutput()).toBeUndefined()
    // ...and the walk can terminate.
    expect(s.hasPendingWork()).toBe(false)
  })

  test('a race node fires exactly once even while a producer is in flight', () => {
    // t → a → r, t → b → r, r → o. The race is ready on its FIRST producer, so
    // it can be claimed while `b` is still running. `inFlight` is what stops it
    // being claimed a second time when `b` lands.
    const s = new Scheduler({
      version: 1,
      nodes: [
        trigger('t'),
        agent('a'),
        agent('b'),
        race('r'),
        output('o', 'r'),
      ],
      edges: [
        edge('t', 'a'),
        edge('t', 'b'),
        edge('a', 'r'),
        edge('b', 'r'),
        edge('r', 'o'),
      ],
    })
    s.seedTrigger({})
    expect(s.takeReady().map((i) => i.node.id).sort()).toEqual(['a', 'b'])

    s.report('a', { output: { from: 'a' } })
    const claimed = s.takeReady()
    expect(claimed.map((i) => i.node.id)).toEqual(['r'])
    expect(claimed[0].input).toEqual({ from: 'a' })

    // `b` lands while the race is still executing — it must not be re-claimed.
    s.report('b', { output: { from: 'b' } })
    expect(s.takeReady()).toEqual([])
  })
})
