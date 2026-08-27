import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import type { WorkflowGraph } from '../../engine/graph'
import type { WfDb } from '../client'
import {
  TOP_LEVEL_ITEM_INDEX,
  wfRun,
  wfRunLog,
  wfRunStep,
  wfSchema,
  wfWorkflow,
  wfWorkflowVersion,
} from '../schema'

import {
  executedGraph,
  getRun,
  getRunForGrading,
  getRunLastActivityAt,
  getRunRetrySource,
} from './runs-inspector'

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../migrations', import.meta.url),
)

function freshDb(): WfDb {
  const sqlite = new Database(':memory:')
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const f of files) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${f}`, 'utf8')
    for (const stmt of sql.split('--> statement-breakpoint')) {
      const trimmed = stmt.trim()
      if (trimmed) sqlite.run(trimmed)
    }
  }
  return drizzle(sqlite, { schema: wfSchema }) as unknown as WfDb
}

const RUN = 'run-1'

async function addRun(db: WfDb, over: Record<string, unknown> = {}) {
  await db.insert(wfRun).values({
    id: RUN,
    workflowVersionId: 'ver-1',
    triggerKind: 'chat',
    status: 'running',
    ...over,
  })
}

// One recorded step. `itemIndex`/`parentNodeId` default to the top-level
// sentinel pair, matching the durable recorder.
async function addStep(
  db: WfDb,
  s: {
    nodeId: string
    nodeKind?: string
    sequence?: number
    status?: 'running' | 'completed' | 'failed' | 'skipped'
    parentNodeId?: string | null
    itemIndex?: number
    input?: unknown
    output?: unknown
  },
) {
  await db.insert(wfRunStep).values({
    runId: RUN,
    nodeId: s.nodeId,
    nodeKind: s.nodeKind ?? 'agent',
    parentNodeId: s.parentNodeId ?? null,
    itemIndex: s.itemIndex ?? -1,
    sequence: s.sequence ?? 0,
    status: s.status ?? 'completed',
    input: s.input ?? {},
    output: s.output ?? {},
  })
}

// One feed entry. `ts` is the engine's emit time, which is what liveness reads.
async function addLog(
  db: WfDb,
  l: { ts: number; nodeId?: string | null; level?: string },
) {
  await db.insert(wfRunLog).values({
    runId: RUN,
    nodeId: l.nodeId ?? 'a',
    nodeKind: 'agent',
    level: l.level ?? 'progress',
    message: 'line',
    ts: l.ts,
  })
}

describe('getRunLastActivityAt', () => {
  let db: WfDb

  beforeEach(async () => {
    db = freshDb()
    await addRun(db)
  })

  test('returns the newest entry ts regardless of insert order', async () => {
    await addLog(db, { ts: 3_000 })
    await addLog(db, { ts: 9_000 })
    // Out of order on purpose: entries are stamped by the emitting node, and
    // parallel arms write theirs interleaved.
    await addLog(db, { ts: 5_000 })

    expect(await getRunLastActivityAt(db, RUN)).toBe(9_000)
  })

  test('is null for a run that has written nothing', async () => {
    expect(await getRunLastActivityAt(db, RUN)).toBeNull()
  })

  test('is null for an unknown run, never borrowing another feed', async () => {
    await addLog(db, { ts: 9_000 })

    expect(await getRunLastActivityAt(db, 'nope')).toBeNull()
  })

  test('advances as a node emits, without the node finishing', async () => {
    // The property the whole read exists for: a long agent node is visible as
    // live WHILE it works. `appendRunLog` writes each entry as it is emitted,
    // so an unfinished node still moves this clock.
    await addLog(db, { ts: 1_000, level: 'node-start' })
    const atStart = await getRunLastActivityAt(db, RUN)
    await addLog(db, { ts: 240_000 })

    expect(atStart).toBe(1_000)
    expect(await getRunLastActivityAt(db, RUN)).toBe(240_000)
  })
})

describe('getRun step cursor', () => {
  let db: WfDb

  beforeEach(async () => {
    db = freshDb()
    await addRun(db)
  })

  test('a full load carries a cursor that rises with insert order', async () => {
    await addStep(db, { nodeId: 'a', sequence: 0 })
    await addStep(db, { nodeId: 'b', sequence: 1 })

    const result = await getRun(db, RUN)

    expect(result?.stepsPartial).toBe(false)
    const cursors = result!.steps.map((s) => s.cursor)
    expect(cursors).toHaveLength(2)
    expect(cursors[1]).toBeGreaterThan(cursors[0])
  })

  test('the cursor is distinct where `sequence` collides', async () => {
    // Exactly the shape that rules `sequence` out as a cursor: an iteration's
    // per-item subgraph restarts its counter at 0 for every item, so the run's
    // own trigger and every item's trigger all sit at sequence 0.
    await addStep(db, { nodeId: 'trigger', nodeKind: 'trigger', sequence: 0 })
    await addStep(db, {
      nodeId: 'inner',
      nodeKind: 'trigger',
      sequence: 0,
      parentNodeId: 'loop',
      itemIndex: 0,
    })
    await addStep(db, {
      nodeId: 'inner',
      nodeKind: 'trigger',
      sequence: 0,
      parentNodeId: 'loop',
      itemIndex: 1,
    })

    const result = await getRun(db, RUN)

    expect(result!.steps.map((s) => s.sequence)).toEqual([0, 0, 0])
    expect(new Set(result!.steps.map((s) => s.cursor)).size).toBe(3)
  })

  test('a watermark withholds only the steps at or below it', async () => {
    await addStep(db, { nodeId: 'a' })
    await addStep(db, { nodeId: 'b' })
    await addStep(db, { nodeId: 'c', status: 'running' })

    const full = await getRun(db, RUN)
    const watermark = full!.steps[0].cursor

    const delta = await getRun(db, RUN, { settledStepCursor: watermark })

    expect(delta?.stepsPartial).toBe(true)
    expect(delta!.steps.map((s) => s.nodeId)).toEqual(['b', 'c'])
  })

  test('an in-flight step keeps arriving until it settles', async () => {
    await addStep(db, { nodeId: 'a' })
    await addStep(db, { nodeId: 'b', status: 'running' })

    const full = await getRun(db, RUN)
    // A watermark can only ever sit below the first unsettled step, so `b` is
    // above it — and stays above it as the row mutates in place.
    const watermark = full!.steps[0].cursor

    await db
      .update(wfRunStep)
      .set({ status: 'completed' })
      .where(and(eq(wfRunStep.runId, RUN), eq(wfRunStep.nodeId, 'b')))

    const delta = await getRun(db, RUN, { settledStepCursor: watermark })

    expect(delta!.steps.map((s) => [s.nodeId, s.status])).toEqual([
      ['b', 'completed'],
    ])
  })

  test('the cost roll-up still spans steps the watermark withheld', async () => {
    await addStep(db, { nodeId: 'a' })
    await addStep(db, { nodeId: 'b', status: 'running' })

    const full = await getRun(db, RUN)
    const delta = await getRun(db, RUN, {
      settledStepCursor: full!.steps[0].cursor,
    })

    // The header totals are run-wide, so trimming the wire payload must not
    // trim them. (Both are null here — no priced agent steps — but they are
    // derived over the same full read either way.)
    expect(delta!.costUsd).toBe(full!.costUsd)
    expect(delta!.totalTokens).toBe(full!.totalTokens)
  })

  test('a watermark of 0 is honoured, not read as "no watermark"', async () => {
    await addStep(db, { nodeId: 'a' })

    const delta = await getRun(db, RUN, { settledStepCursor: 0 })

    // rowids start at 1, so nothing is withheld — but the response must still
    // announce itself as partial so the client merges rather than replaces.
    expect(delta?.stepsPartial).toBe(true)
    expect(delta!.steps).toHaveLength(1)
  })
})

describe('getRunRetrySource', () => {
  let db: WfDb

  beforeEach(() => {
    db = freshDb()
  })

  test('recovers the run identifiers and the trigger input', async () => {
    await addRun(db, { subjectId: 'sub-1', correlationId: 'corr-1' })
    await addStep(db, {
      nodeId: 't',
      nodeKind: 'trigger',
      output: { text: 'hello' },
    })

    const source = await getRunRetrySource(db, RUN)

    expect(source?.triggerKind).toBe('chat')
    expect(source?.subjectId).toBe('sub-1')
    expect(source?.correlationId).toBe('corr-1')
    expect(source?.workflowVersionId).toBe('ver-1')
    expect(source?.triggerInput).toEqual({ text: 'hello' })
  })

  test('never picks an iteration item’s trigger over the run’s own', async () => {
    await addRun(db)
    // Both are `nodeKind: 'trigger'` at `sequence: 0` — the ambiguity that made
    // the old "first trigger step in sequence order" scan unsafe. Written
    // first, so a scan that ignores the parent link would find this one.
    await addStep(db, {
      nodeId: 'inner-trigger',
      nodeKind: 'trigger',
      parentNodeId: 'loop',
      itemIndex: 0,
      output: { text: 'item 0' },
    })
    await addStep(db, {
      nodeId: 't',
      nodeKind: 'trigger',
      output: { text: 'the real input' },
    })

    const source = await getRunRetrySource(db, RUN)

    expect(source?.triggerInput).toEqual({ text: 'the real input' })
  })

  test('yields an empty input for a run that recorded no trigger step', async () => {
    await addRun(db)

    const source = await getRunRetrySource(db, RUN)

    // The run row still resolves — retry reports "nothing to replay" rather
    // than a spurious "run not found".
    expect(source).not.toBeNull()
    expect(source?.triggerInput).toEqual({})
  })

  test('returns null for an unknown run', async () => {
    expect(await getRunRetrySource(db, 'nope')).toBeNull()
  })
})

describe('getRunForGrading', () => {
  let db: WfDb

  beforeEach(() => {
    db = freshDb()
  })

  test('returns the run output and only its top-level steps', async () => {
    await addRun(db, { status: 'completed', output: { text: 'answer' } })
    await addStep(db, { nodeId: 'a', sequence: 0 })
    await addStep(db, { nodeId: 'b', sequence: 1 })
    await addStep(db, {
      nodeId: 'inner',
      sequence: 0,
      parentNodeId: 'loop',
      itemIndex: 0,
    })

    const result = await getRunForGrading(db, RUN)

    expect(result?.output).toEqual({ text: 'answer' })
    // The per-item copies are excluded in SQL — a judge grades the workflow's
    // own nodes, and on a wide iteration those copies are most of the table.
    expect(result!.steps.map((s) => s.nodeId)).toEqual(['a', 'b'])
  })

  test('returns null for an unknown run', async () => {
    expect(await getRunForGrading(db, 'nope')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The graph a run actually executed
// ---------------------------------------------------------------------------
//
// A durable iteration item is spawned against its PARENT's version id plus the
// container's node id, and the engine narrows the subgraph back out before it
// walks anything. The inspector has to narrow the same way or the item's viewer
// renders a graph the item never touched.

function node(id: string, kind: string, config: unknown = {}) {
  return {
    id,
    kind,
    label: id,
    position: { x: 0, y: 0 },
    informUser: { mode: 'off' },
    config,
  }
}

const SUBGRAPH: WorkflowGraph = {
  version: 1,
  nodes: [
    node('item', 'trigger', { triggerKind: 'iteration_item' }),
    node('detail', 'agent', {}),
  ],
  edges: [{ id: 'e', source: 'item', target: 'detail', condition: null }],
} as unknown as WorkflowGraph

function parentGraph(containerKind = 'iteration'): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      node('start', 'trigger', { triggerKind: 'manual' }),
      node(
        'per-recipe',
        containerKind,
        containerKind === 'iteration'
          ? {
              concurrency: 4,
              stopOnError: false,
              itemExecution: 'durable',
              subgraph: SUBGRAPH,
            }
          : {},
      ),
    ],
    edges: [{ id: 'e', source: 'start', target: 'per-recipe', condition: null }],
  } as unknown as WorkflowGraph
}

describe('executedGraph', () => {
  test('an iteration item gets the container\'s subgraph', () => {
    const graph = executedGraph(parentGraph(), {
      nodeId: 'per-recipe',
      itemIndex: 3,
    })

    expect(graph.nodes.map((n) => n.id)).toEqual(['item', 'detail'])
  })

  test('a top-level run gets its version\'s own graph', () => {
    const full = parentGraph()

    expect(executedGraph(full, null)).toBe(full)
  })

  test('a workflow-call callee is never narrowed, whatever its node id', () => {
    // The collision guard. A durable callee ALSO carries a `parent_node_id`,
    // but it runs the callee's own version — that id addresses a node in the
    // PARENT's graph, and narrowing on it alone would hand back a subgraph
    // belonging to a workflow this run never entered. Only a real item index
    // separates the two cases, so the id is deliberately made to match here.
    const callee = parentGraph()

    const graph = executedGraph(callee, {
      nodeId: 'per-recipe',
      itemIndex: TOP_LEVEL_ITEM_INDEX,
    })

    expect(graph).toBe(callee)
  })

  test('a container edited out of the version leaves the graph alone', () => {
    // Not thrown on: the run is historical and still worth inspecting with
    // whatever graph the version does have.
    const full = parentGraph()

    expect(executedGraph(full, { nodeId: 'gone', itemIndex: 0 })).toBe(full)
  })

  test('a parent node that is not an iteration leaves the graph alone', () => {
    const full = parentGraph('workflow')

    expect(executedGraph(full, { nodeId: 'per-recipe', itemIndex: 0 })).toBe(
      full,
    )
  })
})

describe('getRun for a durable iteration item', () => {
  let db: WfDb

  beforeEach(async () => {
    db = freshDb()
    await db.insert(wfWorkflow).values({ id: 'wf-1', name: 'Ingest document' })
    await db.insert(wfWorkflowVersion).values({
      id: 'ver-1',
      workflowId: 'wf-1',
      versionNumber: 2,
      graph: parentGraph(),
    })
  })

  test('the viewer gets the subgraph the item ran, not the parent workflow', async () => {
    await addRun(db, { parentRunId: 'parent-1', parentNodeId: 'per-recipe', itemIndex: 29 })
    // Recorded exactly as the durable backend writes them: subgraph node ids,
    // at the TOP level of the item's own run.
    await addStep(db, { nodeId: 'item', nodeKind: 'trigger', sequence: 0 })
    await addStep(db, { nodeId: 'detail', sequence: 1 })

    const result = await getRun(db, RUN)

    // The invariant that was broken: every step the item recorded addresses a
    // node the viewer can actually show. Handed the parent's graph, not one of
    // them did — so the canvas dimmed every node to `not-run` and the nodes
    // that HAD run were unreachable inside a container.
    const ids = new Set(result!.graph!.nodes.map((n) => n.id))
    for (const step of result!.steps) expect(ids.has(step.nodeId)).toBe(true)
    expect(result!.graph!.nodes).toHaveLength(2)
  })

  test('the version block still names the parent workflow', async () => {
    // Narrowing the graph must not rename the run: an item IS a run of this
    // workflow version, and the header links to it.
    await addRun(db, { parentRunId: 'parent-1', parentNodeId: 'per-recipe', itemIndex: 0 })

    const result = await getRun(db, RUN)

    expect(result?.workflowName).toBe('Ingest document')
    expect(result?.versionNumber).toBe(2)
  })

  test('a top-level run of the same version keeps the whole graph', async () => {
    await addRun(db)

    const result = await getRun(db, RUN)

    expect(result!.graph!.nodes.map((n) => n.id)).toEqual([
      'start',
      'per-recipe',
    ])
  })

  test('a child names the workflow its parent belongs to', async () => {
    // What the breadcrumb reads. Resolved from the PARENT's version, because a
    // durable callee's parent runs a different workflow from the child.
    await db.insert(wfWorkflow).values({ id: 'wf-2', name: 'Drop intake' })
    await db.insert(wfWorkflowVersion).values({
      id: 'ver-2',
      workflowId: 'wf-2',
      versionNumber: 1,
      graph: parentGraph(),
    })
    await db.insert(wfRun).values({
      id: 'parent-1',
      workflowVersionId: 'ver-2',
      triggerKind: 'manual',
      status: 'completed',
    })
    await addRun(db, { parentRunId: 'parent-1', parentNodeId: 'per-recipe', itemIndex: 1 })

    expect((await getRun(db, RUN))?.parentWorkflowName).toBe('Drop intake')
  })

  test('a top-level run resolves no parent name and pays for no lookup', async () => {
    await addRun(db)

    expect((await getRun(db, RUN))?.parentWorkflowName).toBeNull()
  })
})
