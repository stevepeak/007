import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import type {
  WfWorkflowManifestEntry,
  WorkflowCallNode,
  WorkflowGraph,
} from '../engine/graph'
import type { WfDb } from '../storage/client'
import { wfRun, wfSchema, wfWorkflow, wfWorkflowVersion } from '../storage/schema'

import { calleeEventType, type CalleeDoneWire } from './callee-protocol'
import { CalleeWaiters } from './callee-waiters'
import type { GraphWorkflowEnv, GraphWorkflowParams } from './graph-workflow'
import { buildChildWorkflowRunner, type InlineRunRoom } from './inline-run'

// The INLINE engine calling another workflow.
//
// The durable backend gets its half of this for free from the platform (spawn
// in a step, park on `waitForEvent`). This engine has neither, so the same
// handshake is assembled by hand — and the ordering is what makes it correct: a
// callee that finishes almost immediately must not report into a room that
// isn't listening yet.

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

const ENTRY: WfWorkflowManifestEntry = {
  kind: 'workflow',
  id: 'wf-callee',
  versionId: 'v-callee',
  versionNumber: 2,
  name: 'Enrich prices',
  graph: {
    version: 1,
    nodes: [
      {
        id: 't',
        kind: 'trigger',
        label: 'Start',
        position: { x: 0, y: 0 },
        config: { triggerKind: 'manual', engine: 'durable' },
      },
    ],
    edges: [],
  } as unknown as WorkflowGraph,
}

const NODE = {
  id: 'call-1',
  kind: 'workflow',
  label: 'Call',
  position: { x: 0, y: 0 },
  informUser: { mode: 'off' },
  config: { workflowId: 'wf-callee', inputs: {} },
} as unknown as WorkflowCallNode

const PARAMS = {
  runId: 'room-parent',
  workflowRunId: 'run-parent',
  workflowVersionId: 'v-parent',
  triggerInput: {},
  runContext: { triggerKind: 'chat' },
} as unknown as GraphWorkflowParams

/** A room with the REAL waiter mechanics, minus the Durable Object around it. */
function fakeRoom(): InlineRunRoom & { waiters: CalleeWaiters } {
  const waiters = new CalleeWaiters()
  return {
    waiters,
    appendAnswer: () => {},
    waitForCallee: (eventType, timeoutMs) => waiters.wait(eventType, timeoutMs),
    deliverCallee: (eventType, wire) => waiters.deliver(eventType, wire),
  }
}

function envWith(onCreate?: () => never): GraphWorkflowEnv {
  return {
    WF_DB: {} as never,
    GRAPH_WORKFLOW: {
      create: () => {
        onCreate?.()
        return Promise.resolve({ id: 'instance-1' })
      },
    },
    RUN_ROOM: {
      idFromName: (n: string) => n,
      get: () => ({ startInline: () => Promise.resolve() }),
    },
  } as unknown as GraphWorkflowEnv
}

let db: WfDb

beforeEach(async () => {
  db = freshDb()
  await db.insert(wfWorkflow).values([{ id: 'wf-callee', name: 'Enrich prices' }])
  await db
    .insert(wfWorkflowVersion)
    .values([
      { id: 'v-callee', workflowId: 'wf-callee', versionNumber: 2, graph: {} },
    ])
})

describe('CalleeWaiters — the inline engine\'s waitForEvent', () => {
  test('a result delivered while someone waits resolves that wait', async () => {
    const w = new CalleeWaiters()
    const pending = w.wait('e1', 10_000)
    w.deliver('e1', { ok: true, outputJson: '42' })
    expect(await pending).toEqual({ ok: true, outputJson: '42' })
  })

  test('a result that arrives FIRST is not dropped', async () => {
    // The walk registers before it spawns, so this shouldn't happen — but
    // dropping the result would park the caller until its node timeout for no
    // reason at all.
    const w = new CalleeWaiters()
    w.deliver('e1', { ok: true, outputJson: '"early"' })
    expect(await w.wait('e1', 10_000)).toEqual({
      ok: true,
      outputJson: '"early"',
    })
  })

  test('two callers never cross wires', async () => {
    const w = new CalleeWaiters()
    const a = w.wait('e-a', 10_000)
    const b = w.wait('e-b', 10_000)
    w.deliver('e-b', { ok: true, outputJson: '"b"' })
    w.deliver('e-a', { ok: true, outputJson: '"a"' })
    expect(await a).toEqual({ ok: true, outputJson: '"a"' })
    expect(await b).toEqual({ ok: true, outputJson: '"b"' })
  })

  test('a child that never reports times out instead of hanging forever', async () => {
    const w = new CalleeWaiters()
    await expect(w.wait('e1', 5)).rejects.toThrow(/Timed out/)
  })
})

describe('an inline run calling another workflow', () => {
  test('spawns a child run, parks, and unwraps the reported output', async () => {
    const room = fakeRoom()
    const run = buildChildWorkflowRunner({
      env: envWith(),
      room,
      p: PARAMS,
      manifest: [ENTRY],
      db,
    })

    const pending = run({ node: NODE, entry: ENTRY, triggerInput: { a: 1 } })
    // The wait is registered before the spawn returns — deliver immediately and
    // it still lands.
    const wire: CalleeDoneWire = { ok: true, outputJson: '{"total":7}' }
    room.deliverCallee(calleeEventType(NODE.id), wire)

    const result = await pending
    expect(result.output).toEqual({ total: 7 })
    expect(result.engine).toBe('durable')

    const [row] = await db
      .select()
      .from(wfRun)
      .where(eq(wfRun.id, result.childRunId))
    expect(row.parentRunId).toBe('run-parent')
    expect(row.parentNodeId).toBe('call-1')
  })

  test('a failed callee fails the calling node, naming the workflow', async () => {
    const room = fakeRoom()
    const run = buildChildWorkflowRunner({
      env: envWith(),
      room,
      p: PARAMS,
      manifest: [ENTRY],
      db,
    })
    const pending = run({ node: NODE, entry: ENTRY, triggerInput: {} })
    room.deliverCallee(calleeEventType(NODE.id), {
      ok: false,
      error: 'agent blew up',
    })
    await expect(pending).rejects.toThrow(/Enrich prices.*agent blew up/)
  })

  test('a spawn that fails settles the wait instead of stranding it', async () => {
    const room = fakeRoom()
    const run = buildChildWorkflowRunner({
      env: envWith(() => {
        throw new Error('instance quota exceeded')
      }),
      room,
      p: PARAMS,
      manifest: [ENTRY],
      db,
    })
    // The spawn error is what surfaces — not a timeout minutes later from a
    // wait nobody was ever going to answer.
    await expect(
      run({ node: NODE, entry: ENTRY, triggerInput: {} }),
    ).rejects.toThrow(/instance quota exceeded/)
  })
})
