import { describe, expect, test } from 'bun:test'

import { resolveAnswerNodeIds } from './graph-engine'
import { chainGraph } from './executor-test-helpers'

// `chainGraph` is trigger → boom → after → output, with the Output bound to
// `after`. That binding is exactly what names the answer-producing node.
describe('resolveAnswerNodeIds', () => {
  test('reads the node each Output binds to', () => {
    expect([...resolveAnswerNodeIds(chainGraph())]).toEqual(['after'])
  })

  test('collects every arm when a graph has several Outputs', () => {
    const g = chainGraph()
    const twoArms = {
      ...g,
      nodes: [
        ...g.nodes,
        {
          id: 'o2',
          kind: 'output',
          label: 'Out 2',
          position: { x: 800, y: 0 },
          config: { source: { kind: 'ref', nodeId: 'boom', path: '' } },
        },
      ],
    }
    // Only the arm that actually runs will emit, so handing the delta channel
    // to both candidates is safe — and missing one would silently drop the
    // answer on that branch.
    expect([...resolveAnswerNodeIds(twoArms)].sort()).toEqual(['after', 'boom'])
  })

  test('an Output with no source names nothing', () => {
    const g = chainGraph()
    const unbound = {
      ...g,
      nodes: g.nodes.map((n) => (n.id === 'o' ? { ...n, config: {} } : n)),
    }
    expect(resolveAnswerNodeIds(unbound).size).toBe(0)
  })

  test('degrades to empty rather than throwing on an unreadable graph', () => {
    expect(resolveAnswerNodeIds(undefined).size).toBe(0)
    expect(resolveAnswerNodeIds({ nodes: 'nope' }).size).toBe(0)
  })
})
