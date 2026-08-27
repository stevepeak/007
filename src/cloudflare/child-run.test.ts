import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import type { WfWorkflowManifestEntry, WorkflowGraph } from '../engine/graph'
import type { WfDb } from '../storage/client'
import { wfRun, wfSchema, wfWorkflow, wfWorkflowVersion } from '../storage/schema'

import { InvalidEventTypeError } from './callee-protocol'
import {
  reportCalleeResult,
  spawnCalleeRun,
  type ChildRunBindings,
} from './child-run'
import type { GraphWorkflowParams } from './graph-workflow'

// Calling a workflow. Two invariants live here and nowhere else, and both fail
// SILENTLY when broken — a callee that runs on the wrong engine still produces
// an answer, and a child run with no parent link still completes; you only find
// out when the run viewer shows a workflow-call node with nothing under it, or
// when a chat-shaped workflow starts paying for durable steps nobody asked for.

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../migrations', import.meta.url),
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

/** A callee graph whose trigger declares `engine`. */
function calleeGraph(engine?: 'inline' | 'durable'): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      {
        id: 't',
        kind: 'trigger',
        label: 'Start',
        position: { x: 0, y: 0 },
        config: { triggerKind: 'manual', ...(engine ? { engine } : {}) },
      },
    ],
    edges: [],
  } as unknown as WorkflowGraph
}

function entryOf(engine?: 'inline' | 'durable'): WfWorkflowManifestEntry {
  return {
    kind: 'workflow',
    id: 'wf-callee',
    versionId: 'v-callee',
    versionNumber: 3,
    name: 'Enrich prices',
    graph: calleeGraph(engine),
  }
}

type Spy = {
  env: ChildRunBindings
  created: GraphWorkflowParams[]
  started: GraphWorkflowParams[]
  events: Array<{ instanceId: string; type: string; payload: unknown }>
  delivered: Array<{ roomId: string; eventType: string; wire: unknown }>
}

function spyBindings(): Spy {
  const created: GraphWorkflowParams[] = []
  const started: GraphWorkflowParams[] = []
  const events: Spy['events'] = []
  const delivered: Spy['delivered'] = []
  const env = {
    GRAPH_WORKFLOW: {
      create: (opts: { params: GraphWorkflowParams }) => {
        created.push(opts.params)
        return Promise.resolve({ id: 'instance-1' })
      },
      get: (instanceId: string) =>
        Promise.resolve({
          sendEvent: (e: { type: string; payload: unknown }) => {
            events.push({ instanceId, ...e })
            return Promise.resolve()
          },
        }),
    },
    RUN_ROOM: {
      idFromName: (name: string) => name,
      get: (roomId: string) => ({
        startInline: (params: GraphWorkflowParams) => {
          started.push(params)
          return Promise.resolve()
        },
        deliverCallee: (eventType: string, wire: unknown) => {
          delivered.push({ roomId, eventType, wire })
          return Promise.resolve()
        },
      }),
    },
  } as unknown as ChildRunBindings
  return { env, created, started, events, delivered }
}

let db: WfDb

beforeEach(async () => {
  db = freshDb()
  await db.insert(wfWorkflow).values([{ id: 'wf-callee', name: 'Enrich prices' }])
  await db
    .insert(wfWorkflowVersion)
    .values([
      { id: 'v-callee', workflowId: 'wf-callee', versionNumber: 3, graph: {} },
    ])
})

const baseArgs = {
  triggerInput: { docId: 'd1' },
  parentRunId: 'run-parent',
  nodeId: 'node-call',
  runContext: {
    triggerKind: 'document_uploaded',
    actorId: 'user-7',
    subjectId: 'doc-1',
    correlationId: 'corr-1',
    isEval: true,
  },
  manifest: [entryOf()],
  traceId: 'a'.repeat(32),
  eventType: 'wf-callee-done-node-call',
}

describe('the callee picks its own engine', () => {
  test("a callee whose trigger says durable is started as an instance", async () => {
    const spy = spyBindings()
    const spawned = await spawnCalleeRun(spy.env, db, {
      ...baseArgs,
      entry: entryOf('durable'),
      parent: { kind: 'instance', instanceId: 'parent-instance' },
    })

    expect(spawned.engine).toBe('durable')
    expect(spawned.instanceId).toBe('instance-1')
    expect(spy.created).toHaveLength(1)
    expect(spy.started).toHaveLength(0)
  })

  test('a callee whose trigger says inline is started in a room', async () => {
    const spy = spyBindings()
    const spawned = await spawnCalleeRun(spy.env, db, {
      ...baseArgs,
      entry: entryOf('inline'),
      parent: { kind: 'instance', instanceId: 'parent-instance' },
    })

    // The CALLER here is durable (it reports to an instance) and the callee is
    // inline: proof that the two are independent, which is the whole point of
    // the caller having no say.
    expect(spawned.engine).toBe('inline')
    expect(spawned.instanceId).toBeNull()
    expect(spy.started).toHaveLength(1)
    expect(spy.created).toHaveLength(0)
  })

  test('a callee that declares nothing runs durable, the schema default', async () => {
    const spy = spyBindings()
    const spawned = await spawnCalleeRun(spy.env, db, {
      ...baseArgs,
      entry: entryOf(),
      parent: { kind: 'room', roomId: 'room-parent' },
    })
    expect(spawned.engine).toBe('durable')
  })
})

describe('a callee is always a child run', () => {
  test('the run row links back to the calling run and node', async () => {
    const spy = spyBindings()
    const spawned = await spawnCalleeRun(spy.env, db, {
      ...baseArgs,
      entry: entryOf('durable'),
      parent: { kind: 'instance', instanceId: 'parent-instance' },
    })

    const [row] = await db
      .select()
      .from(wfRun)
      .where(eq(wfRun.id, spawned.childRunId))

    expect(row.parentRunId).toBe('run-parent')
    expect(row.parentNodeId).toBe('node-call')
    // A call spawns exactly one callee, so it takes the top-level sentinel
    // rather than an item position — that is what `listChildRuns` renders as a
    // named callee row instead of "Item N".
    expect(row.itemIndex).toBe(-1)
    // It runs the CALLEE's version, not the caller's.
    expect(row.workflowVersionId).toBe('v-callee')
    expect(row.actorId).toBe('user-7')
    expect(row.sentryTraceId).toBe(baseArgs.traceId)
    // An eval's callees are eval runs too, or the dashboards count a child
    // whose parent they exclude.
    expect(row.isEval).toBe(true)
  })

  test('the child is handed the caller\'s frozen manifest and a raw trigger input', async () => {
    const spy = spyBindings()
    await spawnCalleeRun(spy.env, db, {
      ...baseArgs,
      entry: entryOf('durable'),
      parent: { kind: 'room', roomId: 'room-parent' },
    })

    const [params] = spy.created
    // Re-resolving in the child would float every reference to whatever is
    // published at that instant, splitting one logical run across two versions.
    expect(params.inheritedManifest).toEqual(baseArgs.manifest)
    expect(params.triggerInput).toEqual(baseArgs.triggerInput)
    expect(params.subRun).toEqual({
      parent: { kind: 'room', roomId: 'room-parent' },
      eventType: baseArgs.eventType,
    })
  })
})

describe('reporting back', () => {
  const sub = { eventType: 'wf-callee-done-n1' }

  test('a durable caller is woken by an event on its instance', async () => {
    const spy = spyBindings()
    await reportCalleeResult(
      spy.env,
      { ...sub, parent: { kind: 'instance', instanceId: 'parent-instance' } },
      { ok: true, output: { total: 3 } },
    )
    expect(spy.events).toEqual([
      {
        instanceId: 'parent-instance',
        type: sub.eventType,
        payload: { ok: true, outputJson: '{"total":3}' },
      },
    ])
    expect(spy.delivered).toHaveLength(0)
  })

  test('an inline caller is woken by an RPC into its room', async () => {
    const spy = spyBindings()
    await reportCalleeResult(
      spy.env,
      { ...sub, parent: { kind: 'room', roomId: 'room-parent' } },
      { ok: false, error: 'boom' },
    )
    expect(spy.delivered).toEqual([
      {
        roomId: 'room-parent',
        eventType: sub.eventType,
        wire: { ok: false, error: 'boom' },
      },
    ])
    expect(spy.events).toHaveLength(0)
  })

  test('an event type production would reject fails here, where it has a name', async () => {
    // A colon is accepted by miniflare and rejected in production, where the
    // rejection surfaces only as the PARENT timing out with nothing to read.
    const spy = spyBindings()
    await expect(
      reportCalleeResult(
        spy.env,
        { eventType: 'wf:callee', parent: { kind: 'instance', instanceId: 'p' } },
        { ok: true, output: null },
      ),
    ).rejects.toBeInstanceOf(InvalidEventTypeError)
  })
})
