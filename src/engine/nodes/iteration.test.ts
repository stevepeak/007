import { describe, expect, test } from 'bun:test'

import {
  buildIterationSubgraph,
  ITERATION_MAX_ITEMS_CEILING,
  ITERATION_MAX_ITEMS_FALLBACK,
  workflowGraphSchema,
  type IterationNode,
  type WorkflowGraph,
} from '../graph'
import { collectGraphIssues } from '../graph-issues'
import type { RunNodeContext } from '../run-node'
import { createMemorySink } from '../stream-sink'
import { ITERATION_ITEM_TRIGGER_KIND } from '../trigger-registry'

import {
  executeSubgraph,
  iterationItemLimit,
  IterationTooManyItemsError,
  resolveIterationList,
  runIteration,
} from './iteration'

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function iterNode (config: Partial<IterationNode['config']> = {},
  // Matches the schema default. Progress is opt-in, so an `off` iteration says
  // nothing to the user — see the announce tests below.
  informUser: IterationNode['informUser'] = { mode: 'off' }): IterationNode {
  return {
  id: 'it',
  kind: 'iteration',
  position: { x: 0, y: 0 },
  label: 'Iterate',
  informUser,
  config: {
    concurrency: 4,
    stopOnError: false,
    itemExecution: 'inline',
    subgraph: buildIterationSubgraph(),
    ...config,
  },
}
}

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

  // The user-facing announcement. `${n}` is the reason it is emitted here rather
  // than at node start: the count doesn't exist until the list is resolved.
  const announceLines = async (
    informUser: IterationNode['informUser'],
    list: unknown[],
  ) => {
    const sink = createMemorySink()
    await runIteration({
      node: iterNode({ concurrency: 1 }, informUser),
      list,
      runItem: async (item) => item,
      sink,
    })
    return sink.logs.filter((l) => l.level === 'progress').map((l) => l.message)
  }

  test('a static note announces the count before any item runs', async () => {
    const lines = await announceLines(
      { mode: 'static', note: 'Processing ${n} recipes…' },
      ['a', 'b'],
    )
    expect(lines).toEqual([
      'Processing 2 recipes…',
      'Processing item 1 of 2',
      'Processing item 2 of 2',
    ])
  })

  test('an empty list still announces zero', async () => {
    // Emitted ahead of the empty-list short-circuit: "none" is an answer the
    // user asked for, not a reason to stay quiet.
    expect(
      await announceLines(
        { mode: 'static', note: 'Processing ${n} recipes…' },
        [],
      ),
    ).toEqual(['Processing 0 recipes…'])
  })

  test('an off iteration emits nothing, per-item lines included', async () => {
    // Regression guard: these ticks used to fire unconditionally, making
    // iteration the one node kind that spoke to the user with its toggle off.
    expect(await announceLines({ mode: 'off' }, ['a', 'b'])).toEqual([])
  })

  test('resolveIterationList throws a clear error when the ref is not an array', () => {
    expect(() =>
      resolveIterationList(
        iterNode({ source: { kind: 'ref', nodeId: 'src', path: 'words' } }),
        new Map([['src', { words: 'not-an-array' }]]),
      ),
    ).toThrow(/expected an array at node src\.words/)
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
// The fan-out fence — `maxItems`
// ---------------------------------------------------------------------------
//
// The list an iteration loops over is DATA: a bad extraction or a paginated
// source can hand a three-item loop three hundred items. These cover the bound
// that stops that, and the two things that must stay true when it trips — the
// count is visible first, and not one item runs.

describe('iteration fan-out fence', () => {
  test('an over-limit list fails before a single item starts', async () => {
    let calls = 0
    await expect(
      runIteration({
        node: iterNode({ maxItems: 3 }),
        list: [1, 2, 3, 4],
        runItem: async (item) => {
          calls++
          return item
        },
      }),
    ).rejects.toThrow(IterationTooManyItemsError)
    // The whole point of failing over truncating: no per-item work is spawned,
    // so the fence costs nothing rather than half a run's budget.
    expect(calls).toBe(0)
  })

  test('the failure names the node, the count and the limit', async () => {
    const err = (await runIteration({
      node: iterNode({ maxItems: 2 }),
      list: ['a', 'b', 'c'],
      runItem: async (item) => item,
    }).catch((e: unknown) => e)) as IterationTooManyItemsError
    expect(err).toBeInstanceOf(IterationTooManyItemsError)
    expect(err.message).toContain('Iterate')
    expect(err.message).toContain('3 items')
    expect(err.message).toContain('limit of 2')
    expect(err.total).toBe(3)
    expect(err.limit).toBe(2)
  })

  test('a list exactly at the limit runs', async () => {
    const r = await runIteration({
      node: iterNode({ maxItems: 3 }),
      list: [1, 2, 3],
      runItem: async (item) => item,
    })
    expect(r.results).toEqual([1, 2, 3])
  })

  test('logs the resolved count before the fence trips, however quiet the node', async () => {
    // `informUser: off` silences the USER-facing progress lines; the size of a
    // list is a dev-feed fact, and it's the number whoever opens the failed run
    // needs to see next to the error.
    const sink = createMemorySink()
    await runIteration({
      node: iterNode({ maxItems: 2 }, { mode: 'off' }),
      list: ['a', 'b', 'c'],
      runItem: async (item) => item,
      sink,
    }).catch(() => null)
    expect(sink.logs.map((l) => l.message)).toEqual([
      'List resolved to 3 items (limit 2).',
    ])
  })

  test('a node with no bound falls back to the permissive cap, not to none', () => {
    // Only an already-published version can be in this state; it gets a real
    // ceiling, just not one that would retroactively fail a working workflow.
    expect(iterationItemLimit(iterNode())).toBe(ITERATION_MAX_ITEMS_FALLBACK)
    expect(iterationItemLimit(iterNode({ maxItems: 5 }))).toBe(5)
  })

  test('an over-ceiling bound is enforced as written, not clamped', async () => {
    // The Issues panel already told the author this number is too high for
    // inline. Quietly enforcing a different one would make the editor lie.
    const r = await runIteration({
      node: iterNode({ maxItems: ITERATION_MAX_ITEMS_CEILING.inline + 50 }),
      list: Array.from({ length: ITERATION_MAX_ITEMS_CEILING.inline + 10 }),
      runItem: async (item) => item,
    })
    expect(r.meta.total).toBe(ITERATION_MAX_ITEMS_CEILING.inline + 10)
  })
})

// ---------------------------------------------------------------------------
// executeSubgraph — nested scheduler loop for one item
// ---------------------------------------------------------------------------

describe('executeSubgraph', () => {
  test('identity subgraph returns the item unchanged', async () => {
    // The identity subgraph is trigger → output; the iteration_item trigger's
    // output IS the current element, so bind the Output to that trigger.
    const sub = buildIterationSubgraph()
    const trigNode = sub.nodes.find((n) => n.kind === 'trigger')!
    const outNode = sub.nodes.find((n) => n.kind === 'output')!
    ;(outNode.config as { source?: unknown }).source = {
      kind: 'ref',
      nodeId: trigNode.id,
      path: '',
    }
    const out = await executeSubgraph(sub, { hello: 'world' }, dummyCtx)
    expect(out).toEqual({ hello: 'world' })
  })

  test('routes the item through a branch node and emits the decision', async () => {
    const subgraph: WorkflowGraph = {
      version: 1,
      nodes: [
        {
          id: 'item',
          kind: 'trigger',
          informUser: { mode: 'off' as const },
          label: 'Item',
          position: { x: 0, y: 0 },
          config: { triggerKind: ITERATION_ITEM_TRIGGER_KIND },
        },
        {
          id: 'b',
          kind: 'branch',
          informUser: { mode: 'off' as const },
          label: 'Truthy?',
          position: { x: 100, y: 0 },
          // No `source` → tests the whole item input.
          config: { operator: 'is_not_empty' },
        },
        {
          id: 'yes',
          kind: 'output',
          informUser: { mode: 'off' as const },
          label: 'Yes',
          position: { x: 200, y: 0 },
          config: { source: { kind: 'ref', nodeId: 'b', path: '' } },
        },
        {
          id: 'no',
          kind: 'output',
          informUser: { mode: 'off' as const },
          label: 'No',
          position: { x: 200, y: 100 },
          config: { source: { kind: 'ref', nodeId: 'b', path: '' } },
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
// executeSubgraph — draining arms the item's Output does not feed
// ---------------------------------------------------------------------------

// The same regression `executor-drain.test.ts` pins at the top level, one level
// down. `executeSubgraph` used to RETURN on the Output instruction, so a node
// hung off the side of the item's main line — a classifier whose verdict is
// only recorded, a side-effect tool — was left ready-but-never-dispatched. It
// lost the race to the Output and then silently vanished from the trace.
describe('executeSubgraph — background arms inside one item', () => {
  function ctxWithTools(timeline: string[]): RunNodeContext<unknown> {
    const build = (id: string, result: unknown) => ({
      id,
      name: id,
      kind: 'function' as const,
      description: id,
      build: () => () => {
        timeline.push(id)
        return Promise.resolve(result)
      },
    })
    return {
      toolRegistry: new Map([
        ['main', build('main', { text: 'answered' })],
        ['side', build('side', { ok: true })],
        [
          'side-boom',
          {
            id: 'side-boom',
            name: 'side-boom',
            kind: 'function' as const,
            description: 'side-boom',
            build: () => async () => {
              timeline.push('side-boom')
              throw new Error('side arm failed')
            },
          },
        ],
      ]),
      toolDeps: {},
      nodeOutputs: new Map(),
    } as unknown as RunNodeContext<unknown>
  }

  /**
   * item → main → out        (the arm the item's value comes from)
   * item → side              (a dead end — nothing downstream of it)
   *
   * `side` is placed LAST in the node array on purpose: the sequential walk
   * picks the first ready node in array order, which is exactly where a node
   * just added in the editor lands.
   */
  const subgraph = (sideToolId: string): WorkflowGraph => ({
    version: 1,
    nodes: [
      {
        id: 'item',
        kind: 'trigger',
        informUser: { mode: 'off' as const },
        label: 'Item',
        position: { x: 0, y: 0 },
        config: { triggerKind: ITERATION_ITEM_TRIGGER_KIND },
      },
      {
        id: 'main',
        kind: 'tool',
        informUser: { mode: 'off' as const },
        label: 'Main',
        position: { x: 100, y: 0 },
        config: { toolId: 'main', args: {} },
      },
      {
        id: 'out',
        kind: 'output',
        informUser: { mode: 'off' as const },
        label: 'Done',
        position: { x: 200, y: 0 },
        config: { source: { kind: 'ref', nodeId: 'main', path: '' } },
      },
      {
        id: 'side',
        kind: 'tool',
        informUser: { mode: 'off' as const },
        label: 'Side',
        position: { x: 100, y: 100 },
        config: { toolId: sideToolId, args: {} },
      },
    ],
    edges: [
      { id: 'e1', source: 'item', target: 'main', condition: null },
      { id: 'e2', source: 'main', target: 'out', condition: null },
      { id: 'e3', source: 'item', target: 'side', condition: null },
    ],
  })

  test('a dead-end arm still runs after the item Output is reached', async () => {
    const timeline: string[] = []
    const out = await executeSubgraph(
      subgraph('side'),
      { n: 1 },
      ctxWithTools(timeline),
    )

    expect(out).toEqual({ text: 'answered' })
    // The whole point: the arm nothing waits on executed rather than being
    // dropped when the Output won the race.
    expect(timeline).toContain('side')
  })

  test('the dead-end arm is recorded as its own step', async () => {
    const timeline: string[] = []
    const steps: { nodeId: string; status: string }[] = []
    await executeSubgraph(
      subgraph('side'),
      { n: 1 },
      ctxWithTools(timeline),
      {
        parentNodeId: 'it',
        itemIndex: 0,
        recorder: {
          record: async (args) => {
            steps.push({ nodeId: args.nodeId, status: args.status })
          },
        },
      },
    )

    const side = steps.find((s) => s.nodeId === 'side')
    expect(side?.status).toBe('completed')
  })

  test('a drain failure is recorded but does not retract the answer', async () => {
    const timeline: string[] = []
    const steps: { nodeId: string; status: string }[] = []
    const out = await executeSubgraph(
      subgraph('side-boom'),
      { n: 1 },
      ctxWithTools(timeline),
      {
        parentNodeId: 'it',
        itemIndex: 0,
        recorder: {
          record: async (args) => {
            steps.push({ nodeId: args.nodeId, status: args.status })
          },
        },
      },
    )

    // Once the item's answer is out, a side arm blowing up does not fail the
    // item — but the break point is still in the trace.
    expect(out).toEqual({ text: 'answered' })
    expect(timeline).toContain('side-boom')
    expect(steps.find((s) => s.nodeId === 'side')?.status).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
// executeSubgraph — the container's time budget
// ---------------------------------------------------------------------------

// `ctx.modelBudget` bounds the CONTAINER — one `iter:` step, one inline item,
// one callee — not each node inside it. Reissuing it in full per node let a
// multi-agent item spend N × the budget and outlive the step wrapping it, which
// is the silent external kill the budget exists to replace.
describe('executeSubgraph under a container budget', () => {
  const branchSubgraph = (): WorkflowGraph => ({
    version: 1,
    nodes: [
      {
        id: 'item',
        kind: 'trigger',
        informUser: { mode: 'off' as const },
        label: 'Item',
        position: { x: 0, y: 0 },
        config: { triggerKind: ITERATION_ITEM_TRIGGER_KIND },
      },
      {
        id: 'b',
        kind: 'branch',
        informUser: { mode: 'off' as const },
        label: 'Truthy?',
        position: { x: 100, y: 0 },
        config: { operator: 'is_not_empty' },
      },
      {
        id: 'yes',
        kind: 'output',
        informUser: { mode: 'off' as const },
        label: 'Yes',
        position: { x: 200, y: 0 },
        config: { source: { kind: 'ref', nodeId: 'b', path: '' } },
      },
    ],
    edges: [
      { id: 'e1', source: 'item', target: 'b', condition: null },
      { id: 'e2', source: 'b', target: 'yes', condition: 'yes' },
    ],
  })

  const ctxWithBudget = (totalMs: number) =>
    ({
      modelBudget: { totalMs, stepMs: totalMs, toolMs: totalMs },
    }) as unknown as RunNodeContext<unknown>

  test('walks the subgraph while the container has time left', async () => {
    expect(
      await executeSubgraph(branchSubgraph(), 'present', ctxWithBudget(60_000)),
    ).toMatchObject({ result: 'yes' })
  })

  // Naming the node it refused to start is the point: an item that dies here
  // otherwise looks identical to one that died inside the model call.
  test('refuses to start a node once the container is spent', async () => {
    await expect(
      executeSubgraph(branchSubgraph(), 'present', ctxWithBudget(0)),
    ).rejects.toThrow(/time budget was spent before "Truthy\?" could start/)
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
    const sub = structuredClone(bad.config.subgraph)
    const trig = sub.nodes.find((n) => n.kind === 'trigger')!
    ;(trig.config as { triggerKind: string }).triggerKind = 'manual'
    bad.config.subgraph = sub
    expect(() => workflowGraphSchema.parse(wrap(bad))).toThrow(
      /must start with an 'iteration_item' trigger/,
    )
  })

  test('rejects a nested iteration node inside the subgraph', () => {
    const bad = iterNode()
    const sub = structuredClone(bad.config.subgraph)
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
