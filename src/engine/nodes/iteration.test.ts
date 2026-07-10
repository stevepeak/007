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
import { executeSubgraph, runIteration } from './iteration'

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
    itemsPath: '',
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
      input: arr,
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
      input: [1, 2, 3, 4, 5, 6],
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
      input: [],
      runItem: async () => {
        calls++
        return null
      },
    })
    expect(r.results).toEqual([])
    expect(r.meta.items).toEqual([])
    expect(calls).toBe(0)
  })

  test('non-array input throws a clear error naming the path', async () => {
    await expect(
      runIteration({
        node: iterNode({ itemsPath: 'words' }),
        input: { words: 'not-an-array' },
        runItem: async (item) => item,
      }),
    ).rejects.toThrow(/expected an array at 'words'/)
  })

  test('resolves the array at itemsPath', async () => {
    const r = await runIteration({
      node: iterNode({ itemsPath: 'items' }),
      input: { items: ['a', 'b'] },
      runItem: async (item) => String(item).toUpperCase(),
    })
    expect(r.results).toEqual(['A', 'B'])
  })

  test('stopOnError=false collects a failure placeholder and finishes the rest', async () => {
    const r = await runIteration({
      node: iterNode({ stopOnError: false, concurrency: 4 }),
      input: [0, 1, 2, 3],
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
        input: [0, 1, 2, 3],
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

  test('routes the item through a branch node to the matching output', async () => {
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
          config: { path: '', operator: 'is_not_empty' },
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
    expect(await executeSubgraph(subgraph, 'present', dummyCtx)).toBe('present')
    expect(await executeSubgraph(subgraph, '', dummyCtx)).toBe('')
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
    const node = iterNode()
    delete (node.config as { itemsPath?: string }).itemsPath
    const issues = collectGraphIssues(wrap(node) as WorkflowGraph)
    const listIssue = issues.find(
      (i) => i.nodeId === 'it' && /No list selected/.test(i.message),
    )
    expect(listIssue?.severity).toBe('error')
  })

  test('a chosen list (including whole-input "") clears the error', () => {
    for (const itemsPath of ['', 'documents']) {
      const issues = collectGraphIssues(
        wrap(iterNode({ itemsPath })) as WorkflowGraph,
      )
      expect(issues.some((i) => /No list selected/.test(i.message))).toBe(false)
    }
  })
})
