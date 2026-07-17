import { describe, expect, test } from 'bun:test'

import {
  buildIterationSubgraph,
  workflowGraphSchema,
  type IterationNode,
  type WorkflowGraph,
} from '../graph'
import { collectGraphIssues } from '../graph-issues'
import type { RunNodeContext } from '../run-node'
import { ITERATION_ITEM_TRIGGER_KIND } from '../trigger-registry'
import {
  executeSubgraph,
  resolveIterationList,
  runIteration,
} from './iteration'

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const iterNode = (
  config: Partial<IterationNode['config']> = {},
): IterationNode => ({
  id: 'it',
  kind: 'iteration',
  position: { x: 0, y: 0 },
  label: 'Iterate',
  config: {
    concurrency: 4,
    stopOnError: false,
    subgraph: buildIterationSubgraph(),
    ...config,
  },
})

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

// A dummy context — `executeSubgraph`'s identity/branch tests never reach a node
// that touches these deps (trigger/output are handled by the scheduler, branch
// runs in code).
const dummyCtx = {} as unknown as RunNodeContext<unknown>

// ---------------------------------------------------------------------------
// runIteration — concurrency, ordering, error handling
// ---------------------------------------------------------------------------

describe('runIteration', () => {
  test('collects results in input order despite out-of-order completion', async () => {
    const arr = [0, 1, 2, 3, 4]
    const r = await runIteration({
      node: iterNode({ concurrency: 5 }),
      list: arr,
      // Earlier indices finish later, so completion order is reversed.
      runItem: async (item, index) => {
        await delay((arr.length - index) * 4)
        return (item as number) * 10
      },
    })
    expect(r.results).toEqual([0, 10, 20, 30, 40])
    expect(r.meta.total).toBe(5)
    expect(r.meta.items.every((i) => i.status === 'completed')).toBe(true)
  })

  test('never exceeds the configured concurrency', async () => {
    let active = 0
    let peak = 0
    const r = await runIteration({
      node: iterNode({ concurrency: 2 }),
      list: [1, 2, 3, 4, 5, 6],
      runItem: async (item) => {
        active++
        peak = Math.max(peak, active)
        await delay(5)
        active--
        return item
      },
    })
    expect(peak).toBe(2)
    expect(r.results).toEqual([1, 2, 3, 4, 5, 6])
  })

  test('empty list returns no results and never calls runItem', async () => {
    let calls = 0
    const r = await runIteration({
      node: iterNode(),
      list: [],
      runItem: async () => {
        calls++
        return null
      },
    })
    expect(r.results).toEqual([])
    expect(r.meta.items).toEqual([])
    expect(calls).toBe(0)
  })

  test('resolveIterationList throws a clear error when the ref is not an array', () => {
    expect(() =>
      resolveIterationList(
        iterNode({ source: { kind: 'ref', nodeId: 'src', path: 'words' } }),
        new Map([['src', { words: 'not-an-array' }]]),
      ),
    ).toThrow(/expected an array at src\.words/)
  })

  test('resolveIterationList throws when no list is selected', () => {
    expect(() => resolveIterationList(iterNode(), new Map())).toThrow(
      /has no list selected/,
    )
  })

  test('resolveIterationList resolves the array at the ref', () => {
    const list = resolveIterationList(
      iterNode({ source: { kind: 'ref', nodeId: 'src', path: 'items' } }),
      new Map([['src', { items: ['a', 'b'] }]]),
    )
    expect(list).toEqual(['a', 'b'])
  })

  test('stopOnError=false collects a failure placeholder and finishes the rest', async () => {
    const r = await runIteration({
      node: iterNode({ stopOnError: false, concurrency: 4 }),
      list: [0, 1, 2, 3],
      runItem: async (item, index) => {
        if (index === 2) throw new Error('boom')
        return item
      },
    })
    expect(r.results[0]).toBe(0)
    expect(r.results[1]).toBe(1)
    expect(r.results[2]).toEqual({ __iterationError: 'boom' })
    expect(r.results[3]).toBe(3)
    const failed = r.meta.items.filter((i) => i.status === 'failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ index: 2, error: 'boom' })
  })

  test('stopOnError=true aborts remaining items and rethrows', async () => {
    let calls = 0
    await expect(
      runIteration({
        // Sequential so the abort deterministically skips later items.
        node: iterNode({ stopOnError: true, concurrency: 1 }),
        list: [0, 1, 2, 3],
        runItem: async (item, index) => {
          calls++
          if (index === 1) throw new Error('halt')
          return item
        },
      }),
    ).rejects.toThrow('halt')
    // Only items 0 and 1 ran; 2 and 3 were never started.
    expect(calls).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// executeSubgraph — nested scheduler loop for one item
// ---------------------------------------------------------------------------

describe('executeSubgraph', () => {
  test('identity subgraph returns the item unchanged', async () => {
    const out = await executeSubgraph(
      buildIterationSubgraph(),
      { hello: 'world' },
      dummyCtx,
    )
    expect(out).toEqual({ hello: 'world' })
  })

  test('routes the item through a branch node and emits the decision', async () => {
    const subgraph: WorkflowGraph = {
      version: 1,
      nodes: [
        {
          id: 'item',
          kind: 'trigger',
          label: 'Item',
          position: { x: 0, y: 0 },
          config: { triggerKind: ITERATION_ITEM_TRIGGER_KIND },
        },
        {
          id: 'b',
          kind: 'branch',
          label: 'Truthy?',
          position: { x: 100, y: 0 },
          // No `source` → tests the whole item input.
          config: { operator: 'is_not_empty' },
        },
        {
          id: 'yes',
          kind: 'output',
          label: 'Yes',
          position: { x: 200, y: 0 },
          config: {},
        },
        {
          id: 'no',
          kind: 'output',
          label: 'No',
          position: { x: 200, y: 100 },
          config: {},
        },
      ],
      edges: [
        { id: 'e1', source: 'item', target: 'b', condition: null },
        { id: 'e2', source: 'b', target: 'yes', condition: 'yes' },
        { id: 'e3', source: 'b', target: 'no', condition: 'no' },
      ],
    }
    // A branch no longer forwards its input — its output IS the decision, and
    // the taken arm's Output emits it. The `result` reflects the routing.
    expect(await executeSubgraph(subgraph, 'present', dummyCtx)).toMatchObject({
      result: 'yes',
    })
    expect(await executeSubgraph(subgraph, '', dummyCtx)).toMatchObject({
      result: 'no',
    })
  })
})

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe('iteration schema', () => {
  const wrap = (iteration: IterationNode): unknown => ({
    version: 1,
    nodes: [
      {
        id: 't',
        kind: 'trigger',
        label: 'T',
        position: { x: 0, y: 0 },
        config: { triggerKind: 'manual' },
      },
      iteration,
      {
        id: 'o',
        kind: 'output',
        label: 'O',
        position: { x: 400, y: 0 },
        config: {},
      },
    ],
    edges: [
      { id: 'e1', source: 't', target: 'it', condition: null },
      { id: 'e2', source: 'it', target: 'o', condition: null },
    ],
  })

  test('buildIterationSubgraph produces a valid runnable subgraph', () => {
    expect(() =>
      workflowGraphSchema.parse(buildIterationSubgraph()),
    ).not.toThrow()
  })

  test('a graph with a well-formed iteration node parses', () => {
    expect(() => workflowGraphSchema.parse(wrap(iterNode()))).not.toThrow()
  })

  test('rejects a subgraph whose trigger is not the iteration_item kind', () => {
    const bad = iterNode()
    const sub = structuredClone(bad.config.subgraph) as WorkflowGraph
    const trig = sub.nodes.find((n) => n.kind === 'trigger')!
    ;(trig.config as { triggerKind: string }).triggerKind = 'manual'
    bad.config.subgraph = sub
    expect(() => workflowGraphSchema.parse(wrap(bad))).toThrow(
      /must start with an 'iteration_item' trigger/,
    )
  })

  test('rejects a nested iteration node inside the subgraph', () => {
    const bad = iterNode()
    const sub = structuredClone(bad.config.subgraph) as WorkflowGraph
    sub.nodes.push(iterNode())
    bad.config.subgraph = sub
    expect(() => workflowGraphSchema.parse(wrap(bad))).toThrow(
      /cannot contain another iteration node/,
    )
  })

  test('flags an author-time error when no list is selected', () => {
    // iterNode() leaves `source` unset.
    const issues = collectGraphIssues(wrap(iterNode()) as WorkflowGraph)
    const listIssue = issues.find(
      (i) => i.nodeId === 'it' && /No list selected/.test(i.message),
    )
    expect(listIssue?.severity).toBe('error')
  })

  test('a chosen list ref clears the error', () => {
    for (const path of ['', 'documents']) {
      const issues = collectGraphIssues(
        wrap(
          iterNode({ source: { kind: 'ref', nodeId: 't', path } }),
        ) as WorkflowGraph,
      )
      expect(issues.some((i) => /No list selected/.test(i.message))).toBe(false)
    }
  })
})
