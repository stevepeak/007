import { describe, expect, test } from 'bun:test'

import type { WorkflowGraph } from '../engine'
import type { WfRunStepDTO } from '../server/protocol'

import { canSpawnChildRuns, resolveRunSelection } from './run-selection'

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

function workflowCall() {
  return {
    id: 'call',
    kind: 'workflow',
    label: 'Call',
    position: { x: 0, y: 0 },
    config: { workflowId: 'w1', inputs: {} },
  }
}

const PLAIN = { id: 'a', kind: 'agent', label: 'A', position: { x: 0, y: 0 } }

describe('canSpawnChildRuns', () => {
  test('a durable iteration can', () => {
    expect(canSpawnChildRuns(graphOf([PLAIN, iteration('durable')]))).toBe(true)
  })

  test('ANY workflow-call can — a callee always gets a run of its own', () => {
    expect(canSpawnChildRuns(graphOf([workflowCall()]))).toBe(true)
  })

  test('an inline iteration alone cannot — its work is steps on this run', () => {
    expect(canSpawnChildRuns(graphOf([PLAIN, iteration('inline')]))).toBe(false)
  })

  test('an unset item execution cannot — it defaults to inline', () => {
    // A graph published before the knob existed carries no field, and must not
    // start paying for a poll it can never have children for.
    expect(canSpawnChildRuns(graphOf([PLAIN, iteration()]))).toBe(false)
  })

  test('a graph of ordinary nodes cannot', () => {
    expect(canSpawnChildRuns(graphOf([PLAIN]))).toBe(false)
  })

  test('a call INSIDE an inline iteration subgraph counts', () => {
    // An inline item runs in THIS run, so the callee it spawns is this run's
    // own child — miss it and the drill-down disappears.
    expect(
      canSpawnChildRuns(graphOf([iteration('inline', [workflowCall()])])),
    ).toBe(true)
  })

  test('a null graph counts as "cannot rule it out"', () => {
    // The version row is gone, so nothing here can prove the run has no
    // children — and a run whose children are real must not lose its
    // drill-down because its workflow was deleted.
    expect(canSpawnChildRuns(null)).toBe(true)
  })
})

// The per-item picker's label. Same resolution as the activity feed's inline
// path — from the item's own trigger step — so the two can't disagree about
// what item 3 is called while you page through it.
describe('resolveRunSelection — the focused item\'s title', () => {
  function step(over: Partial<WfRunStepDTO>): WfRunStepDTO {
    return {
      nodeId: 'x',
      nodeKind: 'tool',
      parentNodeId: null,
      itemIndex: null,
      sequence: 0,
      status: 'completed',
      input: null,
      output: null,
      branchResult: null,
      cursor: 0,
      meta: null,
      error: null,
      startedAt: null,
      finishedAt: null,
      costUsd: null,
      ...over,
    }
  }

  const graph = graphOf([
    {
      id: 'loop',
      kind: 'iteration',
      label: 'Loop',
      position: { x: 0, y: 0 },
      config: {
        itemTitle: '${title}',
        subgraph: {
          version: 1,
          nodes: [{ id: 'save', kind: 'tool', label: 'Save', position: { x: 0, y: 0 } }],
          edges: [],
        },
      },
    },
  ])

  const steps = [
    step({ nodeId: 'loop', nodeKind: 'iteration', meta: { total: 2 } }),
    step({
      nodeId: 'it',
      nodeKind: 'trigger',
      parentNodeId: 'loop',
      itemIndex: 0,
      output: { title: 'Chocolate Mousse' },
    }),
    step({
      nodeId: 'it',
      nodeKind: 'trigger',
      parentNodeId: 'loop',
      itemIndex: 1,
      output: { title: 'Tarte' },
    }),
  ]

  const select = (selectedItemIndex: number) =>
    resolveRunSelection({
      graph,
      steps,
      runStatus: 'completed',
      selectedId: 'save',
      selectedItemIndex,
      topLevel: new Map(),
    })

  test('names the item currently focused, not the first one', () => {
    expect(select(0).itemTitle).toBe('Chocolate Mousse')
    expect(select(1).itemTitle).toBe('Tarte')
  })

  test('is null when the container carries no template', () => {
    const bare = graphOf([
      {
        id: 'loop',
        kind: 'iteration',
        label: 'Loop',
        position: { x: 0, y: 0 },
        config: {
          subgraph: {
            version: 1,
            nodes: [
              { id: 'save', kind: 'tool', label: 'Save', position: { x: 0, y: 0 } },
            ],
            edges: [],
          },
        },
      },
    ])

    expect(
      resolveRunSelection({
        graph: bare,
        steps,
        runStatus: 'completed',
        selectedId: 'save',
        selectedItemIndex: 0,
        topLevel: new Map(),
      }).itemTitle,
    ).toBeNull()
  })

  test('is null outside an iteration, where there is no item at all', () => {
    expect(
      resolveRunSelection({
        graph,
        steps,
        runStatus: 'completed',
        selectedId: null,
        selectedItemIndex: 0,
        topLevel: new Map(),
      }).itemTitle,
    ).toBeNull()
  })
})
