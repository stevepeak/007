import { describe, expect, test } from 'bun:test'

import type { WorkflowGraph } from '../../engine'

import { engineToFlow } from './workflow-canvas-graph'

// Minimal builders — `engineToFlow` reads id/kind/position/config and nothing
// else, so we cast past the full discriminated-union schema (same approach as
// node-io.test.ts).
const pos = { x: 0, y: 0 }
function node(
  id: string,
  kind: string,
  config: unknown = {},
): WorkflowGraph['nodes'][number] {
  return {
    id,
    kind,
    position: pos,
    label: id,
    informUser: { mode: 'off' },
    config,
  } as unknown as WorkflowGraph['nodes'][number]
}

function graph(nodes: WorkflowGraph['nodes']): WorkflowGraph {
  return { version: 1, nodes, edges: [] }
}

function loop(
  id: string,
  children: WorkflowGraph['nodes'],
): WorkflowGraph['nodes'][number] {
  return node(id, 'iteration', {
    concurrency: 1,
    stopOnError: false,
    itemExecution: 'inline',
    itemTitle: '',
    maxItems: 10,
    subgraph: { version: 1, nodes: children, edges: [] },
  })
}

describe('engineToFlow', () => {
  test('flattens iteration children onto the canvas under their container', () => {
    const flow = engineToFlow(
      graph([
        node('t', 'trigger', { triggerKind: 'manual' }),
        loop('loop', [node('item', 'trigger', { triggerKind: 'iteration_item' })]),
      ]),
    )
    expect(flow.nodes.map((n) => n.id)).toEqual(['t', 'loop', 'item'])
    expect(flow.nodes.find((n) => n.id === 'item')?.parentId).toBe('loop')
  })

  test('emits a reused id once, keeping the first occurrence', () => {
    // Author-time validation rejects this now, but a version published before
    // that gate can still carry it — and the run viewer renders exactly those
    // frozen graphs. Two React Flow children with one key is a console error
    // plus one of them dropped at random, so the collision is resolved here.
    const flow = engineToFlow(
      graph([
        node('t', 'trigger', { triggerKind: 'manual' }),
        loop('loop', [node('dup', 'trigger', { triggerKind: 'iteration_item' })]),
        node('dup', 'tool', { toolId: 'x', args: {} }),
      ]),
    )
    expect(flow.nodes.map((n) => n.id)).toEqual(['t', 'loop', 'dup'])
    // The first one wins: the loop's own Item bookend, not the latecomer.
    expect(flow.nodes.find((n) => n.id === 'dup')?.parentId).toBe('loop')
  })
})
