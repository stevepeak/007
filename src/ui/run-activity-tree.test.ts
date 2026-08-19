import { describe, expect, test } from 'bun:test'

import type { WorkflowGraph } from '../engine'
import type { WfRunLogDTO, WfRunStepDTO } from '../server/protocol'
import { RUN_STATE_LEVEL } from '../engine/stream-sink'
import {
  buildActivityTree,
  flattenTree,
  type ActivityNodeRow,
  type ActivityStateRow,
  type ActivityTopRow,
} from './run-activity-tree'

// Minimal builders — the tree only reads node id/kind/label (+ subgraph for
// iteration containers), so we cast past the full schema shape.
function node(
  id: string,
  kind: string,
  label: string,
  extra: Record<string, unknown> = {},
) {
  return { id, kind, label, position: { x: 0, y: 0 }, ...extra }
}

function graphOf(nodes: ReturnType<typeof node>[]): WorkflowGraph {
  return { version: 1, nodes, edges: [] } as unknown as WorkflowGraph
}

function step(
  nodeId: string,
  nodeKind: string,
  sequence: number,
  status: string,
  extra: Partial<WfRunStepDTO> = {},
): WfRunStepDTO {
  return {
    nodeId,
    nodeKind,
    parentNodeId: null,
    itemIndex: null,
    sequence,
    status,
    input: null,
    output: null,
    branchResult: null,
    meta: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    costUsd: null,
    ...extra,
  }
}

function log(
  nodeId: string | null,
  level: string,
  message: string,
  ts: number,
  extra: Partial<WfRunLogDTO> = {},
): WfRunLogDTO {
  return { nodeId, nodeKind: null, sequence: null, level, message, meta: null, ts, ...extra }
}

function byKey(rows: ActivityNodeRow[], key: string): ActivityNodeRow {
  const found = rows.find((r) => r.key === key)
  if (!found) throw new Error(`no top-level row ${key}`)
  return found
}

const GRAPH = graphOf([
  node('trg', 'trigger', 'Start'),
  node('read', 'tool', 'Read'),
  node('draft', 'agent', 'Draft'),
  node('out', 'output', 'Done'),
])

describe('buildActivityTree — top level', () => {
  test('excludes bookend kinds and orders by executed sequence', () => {
    const rows = buildActivityTree({
      graph: GRAPH,
      steps: [step('read', 'tool', 1, 'completed'), step('draft', 'agent', 2, 'running')],
      logs: [],
    })
    expect(rows.map((r) => r.nodeId)).toEqual(['read', 'draft'])
  })

  test('not-yet-run graph nodes surface as pending rows', () => {
    const rows = buildActivityTree({ graph: GRAPH, steps: [], logs: [] })
    expect(rows.map((r) => r.status)).toEqual(['pending', 'pending'])
    expect(rows.every((r) => !r.expandable)).toBe(true)
  })

  test('duration from step timing, fallback to node-start/end log pairing', () => {
    const rows = buildActivityTree({
      graph: GRAPH,
      steps: [
        step('read', 'tool', 1, 'completed', { startedAt: 1000, finishedAt: 1350 }),
        step('draft', 'agent', 2, 'completed'),
      ],
      logs: [
        log('draft', 'node-start', '▶ Draft', 2000),
        log('draft', 'node-end', '✓ Draft', 2500),
      ],
    })
    expect(byKey(rows, 'read').durationMs).toBe(350)
    expect(byKey(rows, 'draft').durationMs).toBe(500)
  })

  test('attaches thinking/tool leaves but not the node bookends', () => {
    const rows = buildActivityTree({
      graph: GRAPH,
      steps: [step('draft', 'agent', 1, 'completed')],
      logs: [
        log('draft', 'node-start', '▶ Draft', 1),
        log('draft', 'thinking', 'pondering', 2),
        log('draft', 'tool', 'Called search', 3),
        log('draft', 'node-end', '✓ Draft', 4),
      ],
    })
    const draft = byKey(rows, 'draft')
    expect(draft.children.map((c) => c.kind)).toEqual(['log', 'log'])
    expect(draft.children.map((c) => (c.kind === 'log' ? c.level : ''))).toEqual([
      'thinking',
      'tool',
    ])
  })
})

describe('buildActivityTree — iterations', () => {
  const ITER_GRAPH = graphOf([
    node('trg', 'trigger', 'Start'),
    node('loop', 'iteration', 'Save each', {
      config: {
        subgraph: {
          version: 1,
          nodes: [
            node('it', 'iteration_item', 'Item'),
            node('save', 'tool', 'Save one'),
          ],
          edges: [],
        },
      },
    }),
    node('out', 'output', 'Done'),
  ])

  function iterSteps(): WfRunStepDTO[] {
    return [
      step('loop', 'iteration', 1, 'running', { meta: { total: 3 } }),
      // item 0 fully done
      step('save', 'tool', 0, 'completed', {
        parentNodeId: 'loop',
        itemIndex: 0,
        startedAt: 10,
        finishedAt: 40,
      }),
      // item 1 failed; also a bookend trigger step that must be filtered out
      step('it', 'trigger', 0, 'completed', { parentNodeId: 'loop', itemIndex: 1 }),
      step('save', 'tool', 1, 'failed', {
        parentNodeId: 'loop',
        itemIndex: 1,
        error: 'boom',
      }),
    ]
  }

  test('surfaces done/total item counts on the iteration row', () => {
    const rows = buildActivityTree({ graph: ITER_GRAPH, steps: iterSteps(), logs: [] })
    const loop = byKey(rows, 'loop')
    // Two of three items recorded; both terminal (completed + failed) → 2/3.
    expect(loop.itemsTotal).toBe(3)
    expect(loop.itemsDone).toBe(2)
  })

  test('groups inner steps by item, labels from subgraph, rolls up status', () => {
    const rows = buildActivityTree({ graph: ITER_GRAPH, steps: iterSteps(), logs: [] })
    const loop = byKey(rows, 'loop')
    expect(loop.status).toBe('running')
    expect(loop.children.map((c) => (c.kind === 'group' ? c.label : ''))).toEqual([
      'Item 1 / 3',
      'Item 2 / 3',
    ])
    const item0 = loop.children[0]
    const item1 = loop.children[1]
    if (item0.kind !== 'group' || item1.kind !== 'group')
      throw new Error('expected group rows')
    expect(item0.status).toBe('completed')
    expect(item1.status).toBe('failed')
    // Inner 'trigger' step filtered; only the real 'save' node remains.
    expect(item0.children).toHaveLength(1)
    expect((item0.children[0] as ActivityNodeRow).label).toBe('Save one')
    expect((item0.children[0] as ActivityNodeRow).durationMs).toBe(30)
    expect((item0.children[0] as ActivityNodeRow).parentIterationId).toBe('loop')
    expect((item0.children[0] as ActivityNodeRow).itemIndex).toBe(0)
  })

  test('running loop with no items yet shows a live placeholder', () => {
    const rows = buildActivityTree({
      graph: ITER_GRAPH,
      steps: [step('loop', 'iteration', 1, 'running', { meta: { total: 5 } })],
      logs: [],
      live: true,
    })
    const loop = byKey(rows, 'loop')
    expect(loop.children).toHaveLength(1)
    expect(loop.children[0].kind).toBe('log')
    expect(loop.children[0].kind === 'log' && loop.children[0].message).toContain('5')
  })
})

describe('buildActivityTree — sub-agents & null graph', () => {
  test('sub-agent delegations nest under the agent and select the parent', () => {
    const rows = buildActivityTree({
      graph: GRAPH,
      steps: [
        step('draft', 'agent', 1, 'completed'),
        step('sub:draft:0', 'agent', 0, 'completed', {
          parentNodeId: 'draft',
          itemIndex: 0,
          meta: { subAgentName: 'researcher' },
        }),
      ],
      logs: [],
    })
    const draft = byKey(rows, 'draft')
    const sub = draft.children[0]
    if (sub.kind !== 'node') throw new Error('expected sub-agent node row')
    expect(sub.label).toContain('researcher')
    expect(sub.selectNodeId).toBe('draft')
  })

  test('agent rows carry step cost; non-agents leave it null', () => {
    const rows = buildActivityTree({
      graph: GRAPH,
      steps: [
        step('draft', 'agent', 2, 'completed', { costUsd: 0.0123 }),
        step('read', 'tool', 1, 'completed', { costUsd: null }),
      ],
      logs: [],
    })
    expect(byKey(rows, 'draft').costUsd).toBe(0.0123)
    expect(byKey(rows, 'read').costUsd).toBeNull()
  })

  test('null graph builds from steps, ordered by sequence', () => {
    const rows = buildActivityTree({
      graph: null,
      steps: [step('b', 'tool', 2, 'completed'), step('a', 'agent', 1, 'running')],
      logs: [],
    })
    expect(rows.map((r) => r.nodeId)).toEqual(['a', 'b'])
    expect(rows.map((r) => r.label)).toEqual(['a', 'b'])
  })
})

describe('flattenTree', () => {
  test('respects defaultOpen then user overrides, keyed stably', () => {
    const rows = buildActivityTree({
      graph: GRAPH,
      steps: [step('draft', 'agent', 1, 'completed')],
      logs: [log('draft', 'thinking', 'hmm', 2)],
    })
    // draft is a non-iteration node with a log child → defaultOpen true.
    let flat = flattenTree(rows, new Map())
    expect(flat.map((f) => f.row.kind)).toContain('log')

    // Collapse draft → its log leaf drops out of the flattened list.
    flat = flattenTree(rows, new Map([['draft', 'closed']]))
    expect(flat.some((f) => f.row.kind === 'log')).toBe(false)
    expect(flat.find((f) => f.row.key === 'draft')?.expanded).toBe(false)
  })
})


// --- Run lifecycle markers -------------------------------------------------

/** A run-level state entry as the storage writer produces it. */
function stateLog(
  status: string,
  ts: number,
  extra: { message?: string; pendingNodes?: number } = {},
): WfRunLogDTO {
  return {
    nodeId: null,
    nodeKind: null,
    sequence: null,
    level: RUN_STATE_LEVEL,
    message: extra.message ?? status,
    meta: {
      status,
      ...(extra.pendingNodes != null ? { pendingNodes: extra.pendingNodes } : {}),
    },
    ts,
  }
}

const isState = (r: ActivityTopRow): r is ActivityStateRow => r.kind === 'state'
const isNode = (r: ActivityTopRow): r is ActivityNodeRow => r.kind === 'node'

describe('buildActivityTree — run lifecycle markers', () => {
  test('opens with queued then running, and closes with the terminal marker', () => {
    // `read` starts at 2_000_000, `draft` at 5_000_000. `done` at 3_000_000 is
    // between them; everything else is a bookend.
    const rows = buildActivityTree({
      graph: GRAPH,
      steps: [
        step('read', 'tool', 1, 'completed', {
          startedAt: 2_000_000,
          finishedAt: 2_900_000,
        }),
        step('draft', 'agent', 2, 'completed', {
          startedAt: 5_000_000,
          finishedAt: 9_000_000,
        }),
      ],
      logs: [
        stateLog('queued', 1_000_000),
        stateLog('running', 1_500_000),
        stateLog('done', 3_000_000),
        stateLog('completed', 9_500_000),
      ],
    })
    expect(
      rows.map((r) => (isState(r) ? `@${r.status}` : (r as ActivityNodeRow).nodeId)),
    ).toEqual(['@queued', '@running', 'read', '@done', 'draft', '@completed'])
  })

  test('queued and running lead even when a node claims an earlier start', () => {
    // `started_at` is a whole-SECOND column while a marker's ts is exact
    // millis, so inside one second the timestamps can order the wrong way. The
    // bookends are pinned precisely so that can't surface — this fixes the
    // marker ts ABOVE the node start to prove the placement isn't a comparison.
    const rows = buildActivityTree({
      graph: GRAPH,
      steps: [
        step('read', 'tool', 1, 'completed', {
          startedAt: 1_000_000,
          finishedAt: 1_500_000,
        }),
      ],
      logs: [stateLog('queued', 9_000_000), stateLog('running', 9_000_001)],
    })
    expect(
      rows.map((r) => (isState(r) ? `@${r.status}` : (r as ActivityNodeRow).nodeId)),
    ).toEqual(['@queued', '@running', 'read', 'draft'])
  })

  test('a terminal marker closes the list even with nodes that never ran', () => {
    // `draft` was skipped by a branch, so it has no start time. `completed`
    // still belongs at the end — nothing runs after it by definition.
    const rows = buildActivityTree({
      graph: GRAPH,
      steps: [
        step('read', 'tool', 1, 'completed', {
          startedAt: 1_000_000,
          finishedAt: 1_400_000,
        }),
      ],
      logs: [stateLog('completed', 1_500_000)],
    })
    expect(
      rows.map((r) => (isState(r) ? `@${r.status}` : (r as ActivityNodeRow).nodeId)),
    ).toEqual(['read', 'draft', '@completed'])
  })

  test('node ordering is untouched by the markers', () => {
    const withMarkers = buildActivityTree({
      graph: GRAPH,
      steps: [step('read', 'tool', 1, 'completed'), step('draft', 'agent', 2, 'running')],
      logs: [stateLog('running', 1), stateLog('done', 2)],
    })
    expect(withMarkers.filter(isNode).map((r) => r.nodeId)).toEqual([
      'read',
      'draft',
    ])
  })

  test('a state entry never becomes a node leaf', () => {
    // It has no nodeId, so it must not be swallowed by the per-node log index.
    const rows = buildActivityTree({
      graph: GRAPH,
      steps: [step('read', 'tool', 1, 'completed')],
      logs: [stateLog('done', 5)],
    })
    expect(rows.filter(isState)).toHaveLength(1)
    for (const r of rows.filter(isNode)) {
      expect(r.children.some((c) => c.kind === 'log' && c.level === RUN_STATE_LEVEL)).toBe(false)
    }
  })

  test('flattenTree emits markers as depth-0 leaves', () => {
    const rows = buildActivityTree({
      graph: GRAPH,
      steps: [step('read', 'tool', 1, 'completed')],
      logs: [stateLog('done', 5)],
    })
    const flat = flattenTree(rows, new Map())
    const marker = flat.find((f) => f.row.kind === 'state')
    expect(marker).toBeDefined()
    expect(marker?.depth).toBe(0)
    expect(marker?.hasChildren).toBe(false)
  })
})

describe('buildActivityTree — marker timing', () => {
  test('times each marker off the running marker, not the queued one', () => {
    // Queue wait is not run time: `done` at 25s after `running` is 23s of work
    // even though the run was created 2s earlier.
    const rows = buildActivityTree({
      graph: GRAPH,
      steps: [step('read', 'tool', 1, 'completed')],
      logs: [
        stateLog('queued', 1_000_000),
        stateLog('running', 1_002_000),
        stateLog('done', 1_025_000, { pendingNodes: 3 }),
        stateLog('completed', 1_100_000),
      ],
    })
    const byStatus = new Map(rows.filter(isState).map((r) => [r.status, r]))
    expect(byStatus.get('queued')?.elapsedMs).toBeNull()
    expect(byStatus.get('running')?.elapsedMs).toBe(0)
    expect(byStatus.get('done')?.elapsedMs).toBe(23_000)
    expect(byStatus.get('done')?.pendingNodes).toBe(3)
    expect(byStatus.get('completed')?.elapsedMs).toBe(98_000)
  })

  test('leaves elapsed null when the run predates lifecycle markers', () => {
    // No `running` marker to time from — the view falls back to the engine's
    // plain persisted line rather than inventing a duration.
    const rows = buildActivityTree({
      graph: GRAPH,
      steps: [step('read', 'tool', 1, 'completed')],
      logs: [stateLog('completed', 1_100_000, { message: 'Workflow completed' })],
    })
    const marker = rows.filter(isState)[0]
    expect(marker.elapsedMs).toBeNull()
    expect(marker.message).toBe('Workflow completed')
  })
})
