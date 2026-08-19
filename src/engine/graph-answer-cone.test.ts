import { describe, expect, test } from 'bun:test'

import { answerCriticalIds } from './graph-answer-cone'
import { chainGraph } from './executor-test-helpers'
import { workflowGraphSchema, type WorkflowGraph } from './graph'

const parse = (g: unknown): WorkflowGraph => workflowGraphSchema.parse(g)

// `chainGraph` is trigger → boom → after → output, a single answer arm, so
// every node in it is answer-critical.
describe('answerCriticalIds', () => {
  test('takes the whole ancestor closure of an Output, plus the Output', () => {
    const ids = answerCriticalIds(parse(chainGraph()))
    expect([...ids].sort()).toEqual(['after', 'boom', 'o', 't'])
  })

  test('leaves an arm that never reaches an Output out', () => {
    const g = chainGraph()
    const withSide = {
      ...g,
      nodes: [
        ...g.nodes,
        {
          id: 'side',
          kind: 'tool',
          label: 'Side',
          position: { x: 200, y: 200 },
          config: { toolId: 'noop', args: {} },
        },
      ],
      edges: [...g.edges, { id: 'e-side', source: 't', target: 'side', condition: null }],
    }
    const ids = answerCriticalIds(parse(withSide))
    expect(ids.has('side')).toBe(false)
    expect(ids.has('after')).toBe(true)
  })

  test('unions the cones of several Outputs', () => {
    const g = chainGraph()
    const twoArms = {
      ...g,
      nodes: [
        ...g.nodes,
        {
          id: 'alt',
          kind: 'tool',
          label: 'Alt',
          position: { x: 200, y: 200 },
          config: { toolId: 'noop', args: {} },
        },
        {
          id: 'o2',
          kind: 'output',
          label: 'Out 2',
          position: { x: 400, y: 200 },
          config: { source: { kind: 'ref', nodeId: 'alt', path: '' } },
        },
      ],
      edges: [
        ...g.edges,
        { id: 'e-alt', source: 't', target: 'alt', condition: null },
        { id: 'e-alt2', source: 'alt', target: 'o2', condition: null },
      ],
    }
    const ids = answerCriticalIds(parse(twoArms))
    expect(ids.has('alt')).toBe(true)
    expect(ids.has('o2')).toBe(true)
    expect(ids.has('after')).toBe(true)
  })

  test("includes a race node's producers", () => {
    // trigger → a, trigger → b, both → race → output.
    // `analyzeJoinTopology`'s `ancestorCone` deliberately seals at a Race, which
    // would drop `a`/`b` here — they very much feed the answer, which is why
    // this walks `ancestorIds` instead.
    const g = {
      version: 1 as const,
      nodes: [
        {
          id: 't',
          kind: 'trigger',
          label: 'Go',
          position: { x: 0, y: 0 },
          config: { triggerKind: 'go' },
        },
        {
          id: 'a',
          kind: 'tool',
          label: 'A',
          position: { x: 200, y: 0 },
          config: { toolId: 'noop', args: {} },
        },
        {
          id: 'b',
          kind: 'tool',
          label: 'B',
          position: { x: 200, y: 200 },
          config: { toolId: 'noop', args: {} },
        },
        {
          id: 'r',
          kind: 'race',
          label: 'First one wins',
          position: { x: 400, y: 100 },
          config: {},
        },
        {
          id: 'o',
          kind: 'output',
          label: 'Out',
          position: { x: 600, y: 100 },
          config: { source: { kind: 'ref', nodeId: 'r', path: '' } },
        },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'a', condition: null },
        { id: 'e2', source: 't', target: 'b', condition: null },
        { id: 'e3', source: 'a', target: 'r', condition: null },
        { id: 'e4', source: 'b', target: 'r', condition: null },
        { id: 'e5', source: 'r', target: 'o', condition: null },
      ],
    }
    const ids = answerCriticalIds(parse(g))
    expect(ids.has('a')).toBe(true)
    expect(ids.has('b')).toBe(true)
    expect(ids.has('r')).toBe(true)
  })

  test('execution.background demotes a node inside the cone', () => {
    const g = chainGraph()
    const demoted = {
      ...g,
      nodes: g.nodes.map((n) =>
        n.id === 'after' ? { ...n, execution: { background: true } } : n,
      ),
    }
    const ids = answerCriticalIds(parse(demoted))
    expect(ids.has('after')).toBe(false)
    // Demoting a node says nothing about its ancestors — they may feed the
    // answer by another path.
    expect(ids.has('boom')).toBe(true)
  })

  test('a graph with no Output has no answer-critical nodes', () => {
    const g = chainGraph()
    const noOutput = {
      ...g,
      nodes: g.nodes.filter((n) => n.kind !== 'output'),
      edges: g.edges.filter((e) => e.target !== 'o'),
    }
    // Parsing is skipped: the strict gate rejects an Output-less graph, and the
    // derivation must still be total for callers that hold an unvalidated one.
    expect(answerCriticalIds(noOutput as unknown as WorkflowGraph).size).toBe(0)
  })
})
