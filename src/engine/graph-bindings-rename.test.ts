import { describe, expect, test } from 'bun:test'

import type { WorkflowGraph, WorkflowNode } from './graph'
import { renameGraphRefPaths } from './graph-bindings'

// Renaming a Decision question id moves the address its readers bind to. What is
// pinned here is that the readers move WITH it — at every depth, in every slot
// (including inside an iteration's subgraph), and that a sibling id sharing a
// prefix does not get dragged along.

const pos = { x: 0, y: 0 }

function branch(id: string, path: string, reads = 'judge'): WorkflowNode {
  return {
    id,
    kind: 'branch',
    position: pos,
    label: id,
    informUser: { mode: 'off' },
    config: {
      source: { kind: 'ref', nodeId: reads, path },
      operator: 'equals',
      value: true,
    },
  }
}

function graph(nodes: WorkflowNode[]): WorkflowGraph {
  return { version: 1, nodes, edges: [] }
}

const rename = { nodeId: 'judge', from: 'answers.answer_2', to: 'answers.is_urgent' }

/** The `source` ref path of a node that has one — every fixture here does. */
function sourcePath(node: WorkflowNode): string | undefined {
  const source = (node.config as { source?: { path?: string } }).source
  return source?.path
}

describe('renameGraphRefPaths', () => {
  test('moves a ref at the renamed path and below it', () => {
    const g = renameGraphRefPaths(
      graph([
        branch('b1', 'answers.answer_2'),
        branch('b2', 'answers.answer_2.value'),
        branch('b3', 'answers.answer_2.confidence'),
      ]),
      rename,
    )
    expect(g.nodes.map((n) => sourcePath(n))).toEqual([
      'answers.is_urgent',
      'answers.is_urgent.value',
      'answers.is_urgent.confidence',
    ])
  })

  test('leaves a sibling id that merely shares a prefix', () => {
    // The boundary is a dot: `answers.answer_20` is a different question.
    const g = renameGraphRefPaths(graph([branch('b', 'answers.answer_20.value')]), rename)
    expect(sourcePath(g.nodes[0])).toBe('answers.answer_20.value')
  })

  test('leaves refs into a different node alone', () => {
    const g = renameGraphRefPaths(
      graph([branch('b', 'answers.answer_2.value', 'someone-else')]),
      rename,
    )
    expect(sourcePath(g.nodes[0])).toBe('answers.answer_2.value')
  })

  test('reaches every binding slot, including inside an iteration subgraph', () => {
    const agent: WorkflowNode = {
      id: 'a',
      kind: 'agent',
      position: pos,
      label: 'a',
      informUser: { mode: 'off' },
      config: {
        agentId: 'x',
        version: null,
        inputs: { why: { kind: 'ref', nodeId: 'judge', path: 'answers.answer_2.value' } },
      },
    }
    const loop: WorkflowNode = {
      id: 'loop',
      kind: 'iteration',
      position: pos,
      label: 'loop',
      informUser: { mode: 'off' },
      config: {
        source: { kind: 'ref', nodeId: 'judge', path: 'answers.answer_2.value' },
        concurrency: 1,
        stopOnError: false,
        itemExecution: 'inline',
        itemTitle: '',
        maxItems: 10,
        subgraph: { version: 1, nodes: [agent], edges: [] },
      },
    }
    const g = renameGraphRefPaths(graph([loop]), rename)
    const outer = g.nodes[0]
    expect(sourcePath(outer)).toBe('answers.is_urgent.value')
    if (outer.kind !== 'iteration') throw new Error('expected the iteration back')
    const nested = outer.config.subgraph.nodes[0]
    if (nested.kind !== 'agent') throw new Error('expected the agent back')
    expect(nested.config.inputs?.why).toMatchObject({
      path: 'answers.is_urgent.value',
    })
  })

  test('is a no-op when the name did not change', () => {
    const g = graph([branch('b', 'answers.answer_2.value')])
    expect(renameGraphRefPaths(g, { ...rename, to: rename.from })).toBe(g)
  })
})
