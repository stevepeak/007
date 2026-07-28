import { describe, expect, test } from 'bun:test'

import type { WorkflowGraph } from './graph'
import { deriveRunProgress, type ProgressStep } from './run-progress'

// Minimal graph builder — deriveRunProgress only reads node id/kind/label, so we
// don't need full node config here.
function graphOf(
  nodes: { id: string; kind: string; label: string }[],
): WorkflowGraph {
  return {
    version: 1,
    nodes: nodes.map((n) => ({
      ...n,
      position: { x: 0, y: 0 },
    })) as WorkflowGraph['nodes'],
    edges: [],
  }
}

function step(
  nodeId: string,
  sequence: number,
  status: string,
  extra: Partial<ProgressStep> = {},
): ProgressStep {
  return { nodeId, sequence, status, ...extra }
}

const GRAPH = graphOf([
  { id: 'trg', kind: 'trigger', label: 'Start' },
  { id: 'read', kind: 'tool', label: 'Read the document' },
  { id: 'draft', kind: 'agent', label: 'Draft the recipes' },
  { id: 'save', kind: 'iteration', label: 'Save each recipe' },
  { id: 'translate', kind: 'tool', label: 'Translate recipes' },
  { id: 'out', kind: 'output', label: 'Done' },
])
// trigger + output are bookends → 4 executable nodes.

describe('deriveRunProgress', () => {
  test('counts only executable nodes toward total', () => {
    const p = deriveRunProgress({ status: 'queued', graph: GRAPH, steps: [] })
    expect(p.total).toBe(4)
    expect(p.completed).toBe(0)
    expect(p.percent).toBe(0)
    expect(p.activeLabel).toBeNull()
  })

  test('surfaces the running node label and a live percent', () => {
    const p = deriveRunProgress({
      status: 'running',
      graph: GRAPH,
      steps: [
        step('read', 0, 'completed'),
        step('draft', 1, 'running'),
      ],
    })
    expect(p.completed).toBe(1)
    expect(p.activeNodeId).toBe('draft')
    expect(p.activeLabel).toBe('Draft the recipes')
    expect(p.activeKind).toBe('agent')
    expect(p.percent).toBe(25) // 1/4
  })

  test('falls back to the furthest step when none is running', () => {
    const p = deriveRunProgress({
      status: 'running',
      graph: GRAPH,
      steps: [step('read', 0, 'completed'), step('draft', 1, 'completed')],
    })
    // No running step → active is the highest-sequence step.
    expect(p.activeLabel).toBe('Draft the recipes')
    expect(p.completed).toBe(2)
  })

  test('iteration sub-steps roll up under their container, not the top-level count', () => {
    const p = deriveRunProgress({
      status: 'running',
      graph: GRAPH,
      steps: [
        step('read', 0, 'completed'),
        step('draft', 1, 'completed'),
        step('save', 2, 'running'),
        // Two per-item sub-steps inside the iteration container.
        step('child', 3, 'completed', { parentNodeId: 'save' }),
        step('child', 4, 'running', { parentNodeId: 'save' }),
      ],
    })
    // Only read + draft are terminal top-level nodes; sub-steps don't count.
    expect(p.completed).toBe(2)
    expect(p.activeNodeId).toBe('save')
    expect(p.activeLabel).toBe('Save each recipe')
  })

  test('pins percent to 100 once the run is terminal, even with skipped arms', () => {
    const p = deriveRunProgress({
      status: 'completed',
      graph: GRAPH,
      steps: [
        step('read', 0, 'completed'),
        step('draft', 1, 'completed'),
        // save + translate never ran (a branch skipped them) — still 100%.
      ],
    })
    expect(p.percent).toBe(100)
  })

  test('degrades gracefully with no graph (total 0, no bar)', () => {
    const p = deriveRunProgress({
      status: 'running',
      graph: null,
      steps: [step('draft', 0, 'running', { nodeKind: 'agent' })],
    })
    expect(p.total).toBe(0)
    expect(p.percent).toBe(0)
    expect(p.activeNodeId).toBe('draft')
    expect(p.activeLabel).toBeNull() // no graph → no label
    expect(p.activeKind).toBe('agent') // falls back to the step's recorded kind
  })
})
