import { describe, expect, test } from 'bun:test'

import type { WorkflowGraph, WorkflowNode } from './graph'
import { buildIterationSubgraph } from './graph-builders'
import { graphDelta, isEmptyGraphDelta } from './graph-delta'

const pos = { x: 0, y: 0 }
const trigger: WorkflowNode = {
  id: 't',
  kind: 'trigger',
  position: pos,
  label: 'Start',
  informUser: { mode: 'off' },
  config: { triggerKind: 'chat_message' },
}
const tool: WorkflowNode = {
  id: 'step',
  kind: 'tool',
  position: pos,
  label: 'Step',
  informUser: { mode: 'off' },
  config: { toolId: 'echo', args: {} },
}
const base: WorkflowGraph = {
  version: 1,
  nodes: [trigger, tool],
  edges: [{ id: 'e1', source: 't', target: 'step', condition: null }],
}

function withIteration(inner: WorkflowGraph): WorkflowGraph {
  const iteration: WorkflowNode = {
    id: 'loop',
    kind: 'iteration',
    position: pos,
    label: 'Loop',
    informUser: { mode: 'off' },
    config: {
      concurrency: 1,
      stopOnError: false,
      itemExecution: 'inline',
      itemTitle: '',
      subgraph: inner,
    },
  }
  return { ...base, nodes: [...base.nodes, iteration] }
}

describe('graphDelta', () => {
  test('ignores a node that only moved', () => {
    const moved: WorkflowGraph = {
      ...base,
      nodes: base.nodes.map((n) => ({ ...n, position: { x: 9, y: 9 } })),
    }
    expect(isEmptyGraphDelta(graphDelta({ before: base, after: moved }))).toBe(true)
  })

  test('an execution-only change is a change', () => {
    const retried: WorkflowGraph = {
      ...base,
      nodes: [trigger, { ...tool, execution: { retries: { limit: 2 } } }],
    }
    expect(graphDelta({ before: base, after: retried }).nodesChanged).toEqual(['Step (step)'])
  })

  test('ignores object key order', () => {
    const reordered: WorkflowGraph = {
      ...base,
      nodes: [
        trigger,
        {
          config: { args: {}, toolId: 'echo' },
          informUser: { mode: 'off' },
          label: 'Step',
          position: pos,
          kind: 'tool',
          id: 'step',
        },
      ],
    }
    expect(isEmptyGraphDelta(graphDelta({ before: base, after: reordered }))).toBe(true)
  })

  test('compares iteration subgraphs node by node, ignoring layout', () => {
    const inner = buildIterationSubgraph()
    const before = withIteration(inner)
    const resized = withIteration({
      ...inner,
      nodes: inner.nodes.map((n) => ({ ...n, position: { x: 5, y: 5 } })),
    })
    const loop = resized.nodes[2] as Extract<WorkflowNode, { kind: 'iteration' }>
    loop.config.width = 400
    expect(isEmptyGraphDelta(graphDelta({ before, after: resized }))).toBe(true)

    const innerId = inner.nodes[0].id
    const changed = withIteration({
      ...inner,
      nodes: inner.nodes.map((n, i) => (i === 0 ? { ...n, label: 'Renamed' } : n)),
    })
    expect(graphDelta({ before, after: changed }).nodesChanged).toEqual([
      `Renamed (loop/${innerId})`,
    ])
  })
})
