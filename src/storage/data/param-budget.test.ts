import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import type { WfDb } from '../client'
import {
  wfAgent,
  wfFeedback,
  wfRun,
  wfRunStep,
  wfSchema,
  wfWorkflow,
  wfWorkflowVersion,
} from '../schema'

import { deleteWorkflow } from './authoring-workflows'
import { listWorkflowsWithStats } from './authoring-workflows-stats'
import { getFeedbackForSubjects } from './feedback'
import { listAgentCalls } from './runs-agents'
import { listRuns } from './runs-list'
import { loadRunStats } from './runs-rollup'

// D1 rejects any prepared statement binding more than 100 parameters with
// `D1_ERROR: too many SQL variables`. Nothing in the test stack reproduces that
// — bun:sqlite's own ceiling is 32766, so an over-budget `inArray` runs
// perfectly happily here — which is exactly why a "seed 250 rows, assert it
// doesn't throw" test would be worthless. So these tests watch the SQL the
// driver is actually asked to run and assert the bound-parameter count directly.
const D1_MAX_BOUND_PARAMS = 100

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../migrations', import.meta.url),
)

type Probe = {
  db: WfDb
  /** Bound-parameter counts of every statement executed while recording. */
  counts: number[]
  /** Start/stop recording, so seeding inserts don't pollute the assertion. */
  record: (on: boolean) => void
  /** Highest bound-parameter count seen; 0 when nothing was recorded. */
  peak: () => number
}

/** `freshDb()` (the in-memory migrated database every storage test uses) with
 *  the driver wrapped so each statement's bound-parameter count is observable. */
function probeDb(): Probe {
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

  const counts: number[] = []
  let on = false
  const EXECUTORS = ['all', 'get', 'run', 'values', 'iterate']

  // Drizzle prepares a statement and then spreads the binds into the executor,
  // so the parameter count is the executor's own argument count.
  // `Reflect.get` is typed `any`; taking it as `unknown` and narrowing to a
  // callable keeps the reflection honest instead of leaking `any` through every
  // proxied member.
  type AnyFn = (this: unknown, ...args: unknown[]) => unknown
  const asFn = (v: unknown): AnyFn | null =>
    typeof v === 'function' ? (v as AnyFn) : null

  const wrapStatement = (stmt: object) =>
    new Proxy(stmt, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver)
        const fn = asFn(value)
        if (!fn) return value
        if (!EXECUTORS.includes(String(prop))) return fn.bind(target)
        return (...params: unknown[]) => {
          if (on) {
            counts.push(
              params.length === 1 && Array.isArray(params[0])
                ? params[0].length
                : params.length,
            )
          }
          return Reflect.apply(fn, target, params)
        }
      },
    })

  const proxied = new Proxy(sqlite, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver)
      const fn = asFn(value)
      if (!fn) return value
      if (prop === 'prepare' || prop === 'query') {
        return (...args: unknown[]) =>
          wrapStatement(Reflect.apply(fn, target, args) as object)
      }
      return fn.bind(target)
    },
  })

  return {
    db: drizzle(proxied, {
      schema: wfSchema,
    }) as unknown as WfDb,
    counts,
    record: (v) => {
      on = v
    },
    peak: () => (counts.length === 0 ? 0 : Math.max(...counts)),
  }
}

/** Assert the recorded statements stayed inside D1's budget and that we
 *  actually watched something (a silent zero would pass vacuously). */
function expectWithinBudget(probe: Probe) {
  expect(probe.counts.length).toBeGreaterThan(0)
  expect(probe.peak()).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS)
}

function agentMeta (model: string, inputTokens: number, outputTokens: number) {
  return {
  model,
  steps: [{ stepNumber: 1, toolCalls: [] }],
  totalUsage: { inputTokens, outputTokens },
}
}

// Comfortably past 90 (the chunk size) and past 100 (D1's ceiling), and enough
// to force a third chunk so an off-by-one in the slicing shows up.
const N = 250

describe('D1 parameter budget', () => {
  let probe: Probe
  let db: WfDb

  beforeEach(() => {
    probe = probeDb()
    db = probe.db
  })

  test('getFeedbackForSubjects returns every row for an over-budget id list', async () => {
    const subjectIds = Array.from({ length: N }, (_, i) => `msg-${i}`)
    await db.insert(wfFeedback).values(
      subjectIds.map((subjectId) => ({
        subjectId,
        rating: 'up' as const,
      })),
    )

    probe.record(true)
    const rows = await getFeedbackForSubjects(db, subjectIds)
    probe.record(false)

    expect(rows.length).toBe(N)
    expect(new Set(rows.map((r) => r.subjectId)).size).toBe(N)
    expectWithinBudget(probe)
  })

  test('loadRunStats aggregates every run across chunks', async () => {
    await db.insert(wfWorkflow).values({ id: 'wf-1', name: 'Intake' })
    await db
      .insert(wfWorkflowVersion)
      .values({ id: 'v-1', workflowId: 'wf-1', versionNumber: 1, graph: {} })
    const runIds = Array.from({ length: N }, (_, i) => `run-${i}`)
    await db.insert(wfRun).values(
      runIds.map((id) => ({
        id,
        workflowVersionId: 'v-1',
        triggerKind: 'chat',
        status: 'completed' as const,
        isEval: false,
      })),
    )
    // Two agent steps per run, so the per-run token sum is only right if the
    // fold sees both — i.e. if chunks are concatenated rather than overwritten.
    await db.insert(wfRunStep).values(
      runIds.flatMap((runId, i) =>
        [1, 2].map((sequence) => ({
          runId,
          nodeId: `node-${sequence}`,
          nodeKind: 'agent',
          sequence,
          status: 'completed' as const,
          meta: agentMeta('m', 10 + i, 5),
        })),
      ),
    )

    probe.record(true)
    const stats = await loadRunStats(db, runIds)
    probe.record(false)

    expect(stats.size).toBe(N)
    // Every run: two steps of (10 + i) input + 5 output tokens.
    for (const [i, runId] of runIds.entries()) {
      expect(stats.get(runId)?.totalTokens).toBe(2 * (10 + i + 5))
    }
    expectWithinBudget(probe)
  })

  test('listRuns attaches cost to a full over-budget page', async () => {
    await db.insert(wfWorkflow).values({ id: 'wf-1', name: 'Intake' })
    await db
      .insert(wfWorkflowVersion)
      .values({ id: 'v-1', workflowId: 'wf-1', versionNumber: 1, graph: {} })
    const runIds = Array.from({ length: N }, (_, i) => `run-${i}`)
    await db.insert(wfRun).values(
      runIds.map((id, i) => ({
        id,
        workflowVersionId: 'v-1',
        triggerKind: 'chat',
        status: 'completed' as const,
        isEval: false,
        createdAt: new Date(1_700_000_000_000 + i * 1000),
      })),
    )
    await db.insert(wfRunStep).values(
      runIds.map((runId) => ({
        runId,
        nodeId: 'node-1',
        nodeKind: 'agent',
        sequence: 1,
        status: 'completed' as const,
        meta: agentMeta('m', 7, 3),
      })),
    )

    probe.record(true)
    // 200 is RUN_PAGE_MAX — the largest page a caller can ask for, and twice
    // D1's parameter ceiling.
    const page = await listRuns(db, { limit: 200 })
    probe.record(false)

    expect(page.rows.length).toBe(200)
    expect(page.total).toBe(N)
    for (const row of page.rows) expect(row.totalTokens).toBe(10)
    expectWithinBudget(probe)
  })

  test('listWorkflowsWithStats rolls up an over-budget workflow set', async () => {
    const workflowIds = Array.from({ length: 150 }, (_, i) => `wf-${i}`)
    await db
      .insert(wfWorkflow)
      .values(workflowIds.map((id) => ({ id, name: id })))
    await db.insert(wfWorkflowVersion).values(
      workflowIds.map((workflowId) => ({
        id: `v-${workflowId}`,
        workflowId,
        versionNumber: 1,
        graph: { nodes: [], edges: [] },
      })),
    )
    // One non-eval run per workflow, so every workflow's `runCount` is 1 —
    // a group lost to chunking would show up as a missing count.
    await db.insert(wfRun).values(
      workflowIds.map((workflowId) => ({
        id: `run-${workflowId}`,
        workflowVersionId: `v-${workflowId}`,
        triggerKind: 'chat',
        status: 'completed' as const,
        isEval: false,
      })),
    )

    probe.record(true)
    const rows = await listWorkflowsWithStats(db)
    probe.record(false)

    expect(rows.length).toBe(150)
    for (const row of rows) {
      expect(row.latestVersionNumber).toBe(1)
      expect(row.runCount).toBe(1)
    }
    expectWithinBudget(probe)
  })

  test('deleteWorkflow cascades over an over-budget run set', async () => {
    await db.insert(wfWorkflow).values({ id: 'wf-1', name: 'Intake' })
    await db
      .insert(wfWorkflowVersion)
      .values({ id: 'v-1', workflowId: 'wf-1', versionNumber: 1, graph: {} })
    const runIds = Array.from({ length: N }, (_, i) => `run-${i}`)
    await db.insert(wfRun).values(
      runIds.map((id) => ({
        id,
        workflowVersionId: 'v-1',
        triggerKind: 'chat',
        status: 'completed' as const,
        isEval: false,
      })),
    )
    await db.insert(wfRunStep).values(
      runIds.map((runId) => ({
        runId,
        nodeId: 'node-1',
        nodeKind: 'agent',
        sequence: 1,
        status: 'completed' as const,
      })),
    )

    probe.record(true)
    await deleteWorkflow(db, 'wf-1')
    probe.record(false)

    expect((await db.select().from(wfRun)).length).toBe(0)
    expect((await db.select().from(wfRunStep)).length).toBe(0)
    expect((await db.select().from(wfWorkflowVersion)).length).toBe(0)
    expect((await db.select().from(wfWorkflow)).length).toBe(0)
    expectWithinBudget(probe)
  })

  test('listAgentCalls merges the per-chunk pages into one global top-N', async () => {
    // Every node id is a separate bound parameter in the attribution arm, so
    // 250 agent nodes spread across versions forces three chunked pages — and
    // each page returns its OWN newest `limit` rows, which only add up to the
    // right answer once merged and re-sorted.
    await db.insert(wfAgent).values({ id: 'agent-1', name: 'Drafter' })
    await db.insert(wfWorkflow).values({ id: 'wf-1', name: 'Intake' })
    const nodeIds = Array.from({ length: N }, (_, i) => `node-${i}`)
    await db.insert(wfWorkflowVersion).values({
      id: 'v-1',
      workflowId: 'wf-1',
      versionNumber: 1,
      graph: {
        nodes: nodeIds.map((id) => ({
          id,
          kind: 'agent',
          config: { agentId: 'agent-1' },
        })),
        edges: [],
      },
    })
    // One run per node, newest last. The step carries no `meta.agentId`, so the
    // node-id arm is the ONLY thing attributing it to the agent.
    await db.insert(wfRun).values(
      nodeIds.map((_, i) => ({
        id: `run-${i}`,
        workflowVersionId: 'v-1',
        triggerKind: 'chat',
        status: 'completed' as const,
        isEval: false,
        createdAt: new Date(1_700_000_000_000 + i * 1000),
      })),
    )
    await db.insert(wfRunStep).values(
      nodeIds.map((nodeId, i) => ({
        runId: `run-${i}`,
        nodeId,
        nodeKind: 'agent',
        sequence: 1,
        status: 'completed' as const,
        meta: agentMeta('m', 1, 1),
      })),
    )

    probe.record(true)
    const calls = await listAgentCalls(db, { agentId: 'agent-1', limit: 20 })
    probe.record(false)

    expect(calls.length).toBe(20)
    // The 20 newest runs overall, newest first — NOT whichever rows the last
    // chunk happened to return.
    expect(calls.map((c) => c.runId)).toEqual(
      Array.from({ length: 20 }, (_, i) => `run-${N - 1 - i}`),
    )
    expectWithinBudget(probe)
  })
})
