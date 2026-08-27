import { describe, expect, test } from 'bun:test'

import type { WorkflowGraph } from '../engine'

import { canSpawnChildRuns } from './run-selection'

// `canSpawnChildRuns` is the gate on the run viewer's child-runs fetch. Getting
// it wrong is silent in both directions: too permissive adds a query and a
// 1.5s poll to every run in the system; too strict leaves a durable fan-out
// rendering as a node with nothing under it, which is exactly the black box
// NEW-177 exists to remove.

function graphOf(nodes: Array<Record<string, unknown>>): WorkflowGraph {
  return { version: 1, nodes, edges: [] } as unknown as WorkflowGraph
}

function iteration(itemExecution?: string, subgraph: unknown[] = []) {
  return {
    id: 'loop',
    kind: 'iteration',
    label: 'Loop',
    position: { x: 0, y: 0 },
    config: {
      ...(itemExecution ? { itemExecution } : {}),
      subgraph: { version: 1, nodes: subgraph, edges: [] },
    },
  }
}

function workflowCall(calleeExecution?: string) {
  return {
    id: 'call',
    kind: 'workflow',
    label: 'Call',
    position: { x: 0, y: 0 },
    config: calleeExecution ? { calleeExecution } : {},
  }
}

const PLAIN = { id: 'a', kind: 'agent', label: 'A', position: { x: 0, y: 0 } }

describe('canSpawnChildRuns', () => {
  test('a durable iteration can', () => {
    expect(canSpawnChildRuns(graphOf([PLAIN, iteration('durable')]))).toBe(true)
  })

  test('a durable workflow-call can', () => {
    expect(canSpawnChildRuns(graphOf([workflowCall('durable')]))).toBe(true)
  })

  test('inline nodes cannot — their work is steps on this run', () => {
    expect(
      canSpawnChildRuns(
        graphOf([PLAIN, iteration('inline'), workflowCall('inline')]),
      ),
    ).toBe(false)
  })

  test('an unset execution mode cannot — both default to inline', () => {
    // A graph published before the knob existed carries neither field, and must
    // not start paying for a poll it can never have children for.
    expect(canSpawnChildRuns(graphOf([iteration(), workflowCall()]))).toBe(false)
  })

  test('a graph of ordinary nodes cannot', () => {
    expect(canSpawnChildRuns(graphOf([PLAIN]))).toBe(false)
  })

  test('a durable call INSIDE an iteration subgraph does not count', () => {
    // That node belongs to the item's run — it spawns a grandchild, listed
    // under the child, not here. Counting it would fetch children this run
    // never has.
    expect(
      canSpawnChildRuns(
        graphOf([iteration('inline', [workflowCall('durable')])]),
      ),
    ).toBe(false)
  })

  test('a null graph counts as "cannot rule it out"', () => {
    // The version row is gone, so nothing here can prove the run has no
    // children — and a run whose children are real must not lose its
    // drill-down because its workflow was deleted.
    expect(canSpawnChildRuns(null)).toBe(true)
  })
})
