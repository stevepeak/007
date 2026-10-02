import { describe, expect, test } from 'bun:test'

import { Scheduler } from './scheduler'
import { agent, edge, output, trigger } from './scheduler-test-helpers'

const fast = (source: string, target: string) => {
  return { ...edge(source, target), fastTrack: true }
}

describe('Scheduler — fast track', () => {
  // t → a → b → o   (a→b marked)
  // t → side        (unrelated, declared first)
  const graph = () => {
    return new Scheduler({
      version: 1,
      nodes: [
        trigger('t'),
        agent('side'),
        agent('a'),
        agent('b'),
        output('o', 'b'),
      ],
      edges: [
        edge('t', 'side'),
        edge('t', 'a'),
        fast('a', 'b'),
        edge('b', 'o'),
      ],
    })
  }

  test('off-track nodes are held while the track is running', () => {
    const s = graph()
    s.seedTrigger({})
    expect(s.takeReady().map((i) => i.node.id)).toEqual(['a'])
    // `side` stays ready but unclaimed while `a` runs.
    expect(s.takeReady()).toEqual([])
  })

  test('held nodes release once no track node is running or ready', () => {
    const s = graph()
    s.seedTrigger({})
    s.takeReady()
    s.report('a', { output: 1 })
    expect(s.takeReady().map((i) => i.node.id)).toEqual(['b'])
    s.report('b', { output: 2 })
    expect(s.takeReady().map((i) => i.node.id)).toEqual(['side'])
  })

  test('ancestors of the track are pulled onto it', () => {
    // side → b is the only marked edge; `a` feeds b but is off the marked path.
    const s = new Scheduler({
      version: 1,
      nodes: [
        trigger('t'),
        agent('x'),
        agent('a'),
        agent('b'),
        output('o', 'b'),
      ],
      edges: [
        edge('t', 'x'),
        edge('t', 'a'),
        edge('a', 'b'),
        fast('x', 'b'),
        edge('b', 'o'),
      ],
    })
    s.seedTrigger({})
    expect(s.takeReady().map((i) => i.node.id)).toEqual(['x', 'a'])
  })

  test('a graph with no marked edges dispatches exactly as before', () => {
    const s = new Scheduler({
      version: 1,
      nodes: [trigger('t'), agent('side'), agent('a'), output('o', 'a')],
      edges: [edge('t', 'side'), edge('t', 'a'), edge('a', 'o')],
    })
    s.seedTrigger({})
    expect(s.takeReady().map((i) => i.node.id)).toEqual(['a', 'side'])
  })
})
