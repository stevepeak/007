import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import type { WfDb } from '../client'
import {
  wfModel,
  wfRun,
  wfRunStep,
  wfSchema,
  wfWorkflow,
  wfWorkflowVersion,
} from '../schema'

import { descendantRunIds, MAX_RUN_TREE_DEPTH } from './runs-children'
import { aggregateRunCost } from './runs-cost'
import { createRun } from './runs-lifecycle'
import { listRuns } from './runs-list'
import { loadRunStats, rollUpRunCost } from './runs-rollup'

// The tree roll-up (NEW-175). A durable iteration moves an item's steps onto
// the item's OWN run, so a parent's own totals stop describing what the run
// cost — the local D1 holds a real fan-out with 12 steps on the child and the
// loop on the parent.
//
// These execute against a migrated schema rather than asserting on query
// objects: the walk, the grouped usage read and the window sum are three
// separate queries whose results have to agree about which run is whose, and a
// mistake there is a valid query returning a wrong number.

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

let db: WfDb
let seq = 0

beforeEach(async () => {
  db = freshDb()
  await db.insert(wfWorkflow).values({ id: 'wf-1', name: 'Ingest document' })
  await db
    .insert(wfWorkflowVersion)
    .values({ id: 'v-1', workflowId: 'wf-1', versionNumber: 1, graph: {} })
  // $1 per 1M tokens, prompt and completion alike, so a token count reads
  // straight off as a dollar figure and the arithmetic below stays checkable.
  await db.insert(wfModel).values({
    id: 'openrouter:flash',
    providerId: 'openrouter',
    modelId: 'flash',
    label: 'Flash',
    promptPricePerMTok: 1,
    completionPricePerMTok: 1,
  })
})

const base = { workflowVersionId: 'v-1', triggerKind: 'upload' }

/** An agent step costing `tokens` tokens, optionally with a closed window. */
async function agentStep(
  runId: string,
  tokens: number,
  opts: { model?: string; seconds?: number; agentVersion?: number } = {},
) {
  seq += 1
  await db.insert(wfRunStep).values({
    id: `step-${seq}`,
    runId,
    nodeId: `n-${seq}`,
    nodeKind: 'agent',
    sequence: seq,
    status: 'completed',
    meta: {
      model: opts.model ?? 'flash',
      steps: [],
      totalUsage: { inputTokens: tokens, outputTokens: 0 },
      ...(opts.agentVersion != null ? { agentVersion: opts.agentVersion } : {}),
    },
    ...(opts.seconds != null
      ? {
          startedAt: new Date(0),
          finishedAt: new Date(opts.seconds * 1000),
        }
      : {}),
  })
}

async function settle(
  runId: string,
  status: 'completed' | 'failed' | 'running',
  seconds?: number,
) {
  await db
    .update(wfRun)
    .set({
      status,
      ...(seconds != null
        ? { startedAt: new Date(0), finishedAt: new Date(seconds * 1000) }
        : {}),
    })
    .where(eq(wfRun.id, runId))
}

/** A parent with `n` durable iteration items beneath it. */
async function fanOut(n: number, nodeId = 'per-recipe') {
  const parentId = await createRun(db, base)
  const children: string[] = []
  for (let i = 0; i < n; i++) {
    children.push(
      await createRun(db, {
        ...base,
        parent: { runId: parentId, nodeId, itemIndex: i },
      }),
    )
  }
  return { parentId, children }
}

describe('rollUpRunCost', () => {
  test('sums a fan-out its children paid for', async () => {
    const { parentId, children } = await fanOut(3)
    // The shape that motivates the whole ticket: the parent dispatches a loop
    // and spends almost nothing; the items do the work.
    await agentStep(parentId, 1_000)
    for (const c of children) await agentStep(c, 1_000_000)

    const own = await aggregateRunCost(db, [parentId])
    const tree = (await rollUpRunCost(db, [parentId])).get(parentId)

    expect(own.get(parentId)?.totalTokens).toBe(1_000)
    expect(tree?.totalTokens).toBe(3_001_000)
    expect(tree?.costUsd).toBeCloseTo(3.001, 6)
    expect(tree?.runCount).toBe(4)
  })

  test('reaches a grandchild, not just one level', async () => {
    const { parentId, children } = await fanOut(1)
    const grandchild = await createRun(db, {
      ...base,
      parent: { runId: children[0], nodeId: 'call', itemIndex: -1 },
    })
    await agentStep(grandchild, 500_000)

    const tree = (await rollUpRunCost(db, [parentId])).get(parentId)

    // A durable item that itself calls a workflow durably is two levels down.
    // One level would report null here and the parent would read as free.
    expect(tree?.totalTokens).toBe(500_000)
    expect(tree?.runCount).toBe(3)
  })

  test('a childless run rolls up to exactly its own total', async () => {
    const runId = await createRun(db, base)
    await agentStep(runId, 42)

    const tree = (await rollUpRunCost(db, [runId])).get(runId)
    const own = await aggregateRunCost(db, [runId])

    expect(tree?.runCount).toBe(1)
    expect(tree?.totalTokens).toBe(own.get(runId)?.totalTokens)
  })

  test('unions the models used anywhere in the tree', async () => {
    const { parentId, children } = await fanOut(2)
    await agentStep(parentId, 10, { model: 'router' })
    await agentStep(children[0], 10, { model: 'flash' })
    await agentStep(children[1], 10, { model: 'flash' })

    const tree = (await rollUpRunCost(db, [parentId])).get(parentId)

    expect(tree?.models.sort()).toEqual(['flash', 'router'])
  })

  test('computeMs is additive and exceeds the parent wall clock', async () => {
    const { parentId, children } = await fanOut(3)
    await settle(parentId, 'completed', 10)
    // Three items, ten seconds each, run concurrently inside the parent's ten.
    for (const c of children) await settle(c, 'completed', 10)

    const tree = (await rollUpRunCost(db, [parentId])).get(parentId)

    // 40s of work in 10s of elapsed. Summing these into a single "duration"
    // would report a four-fold overstatement as the run's elapsed time; the
    // gap between the two IS the return on running the items durably.
    expect(tree?.computeMs).toBe(40_000)
    expect(tree?.rootWallMs).toBe(10_000)
  })

  test('an unclosed run contributes no time but is counted as pending', async () => {
    const { parentId, children } = await fanOut(2)
    await settle(parentId, 'running')
    await settle(children[0], 'completed', 5)
    await settle(children[1], 'running')

    const tree = (await rollUpRunCost(db, [parentId])).get(parentId)

    expect(tree?.computeMs).toBe(5_000)
    // The parent and one item. Non-zero is what tells the UI these totals are
    // a floor — and it is why the roll-up is derived rather than cached when a
    // run closes: a child that never closes would freeze a cached total.
    expect(tree?.pending).toBe(2)
  })

  test('a settled tree reports nothing pending', async () => {
    const { parentId, children } = await fanOut(2)
    await settle(parentId, 'completed', 4)
    await settle(children[0], 'completed', 2)
    // A FAILED item is settled — it will never contribute more.
    await settle(children[1], 'failed', 1)

    expect((await rollUpRunCost(db, [parentId])).get(parentId)?.pending).toBe(0)
  })

  test('a failed child still contributes what it spent', async () => {
    const { parentId, children } = await fanOut(1)
    await agentStep(children[0], 250_000)
    await settle(children[0], 'failed')

    // Tokens burned before a failure are tokens billed. Excluding them would
    // under-report exactly the runs someone is investigating.
    expect(
      (await rollUpRunCost(db, [parentId])).get(parentId)?.totalTokens,
    ).toBe(250_000)
  })

  test('a run whose row is gone is absent, not zeroed', async () => {
    expect((await rollUpRunCost(db, ['no-such-run'])).size).toBe(0)
  })

  test('an empty root list reads nothing', async () => {
    expect((await rollUpRunCost(db, [])).size).toBe(0)
  })

  test('unrelated roots keep separate totals', async () => {
    const { parentId: a, children } = await fanOut(1)
    const b = await createRun(db, base)
    await agentStep(children[0], 100)

    const totals = await rollUpRunCost(db, [a, b])

    expect(totals.get(a)?.totalTokens).toBe(100)
    expect(totals.get(b)?.totalTokens).toBeNull()
    expect(totals.get(b)?.runCount).toBe(1)
  })
})

describe('descendantRunIds', () => {
  test('a cycle terminates instead of walking forever', async () => {
    const a = await createRun(db, base)
    const b = await createRun(db, {
      ...base,
      parent: { runId: a, nodeId: 'n', itemIndex: 0 },
    })
    // Not something the engine can write — `parent_run_id` is stamped once at
    // spawn — but the walk must not hang if it ever appears.
    await db.update(wfRun).set({ parentRunId: b }).where(eq(wfRun.id, a))

    const trees = await descendantRunIds(db, [a])

    // `a` is already claimed as its own root, so the back-edge is dropped.
    expect(trees.get(a)?.sort()).toEqual([a, b].sort())
  })

  test('stops at the depth bound rather than following a long chain', async () => {
    let previous = await createRun(db, base)
    const root = previous
    const depth = MAX_RUN_TREE_DEPTH + 3
    for (let i = 0; i < depth; i++) {
      previous = await createRun(db, {
        ...base,
        parent: { runId: previous, nodeId: 'n', itemIndex: 0 },
      })
    }

    const ids = (await descendantRunIds(db, [root])).get(root) ?? []

    // Root plus one level per iteration of the walk. Under-reporting a total
    // is recoverable; hanging a page load on an unbounded walk is not.
    expect(ids.length).toBe(MAX_RUN_TREE_DEPTH + 1)
  })

  test('a run passed as both root and descendant is claimed once', async () => {
    const { parentId, children } = await fanOut(1)
    const child = children[0]

    const trees = await descendantRunIds(db, [parentId, child])

    // Roots are independent questions, not a partition: the parent still owns
    // the whole subtree even though the child was also asked about directly.
    // Claiming each run once would silently shrink the parent's total.
    expect(trees.get(parentId)).toEqual([parentId, child])
    expect(trees.get(child)).toEqual([child])
  })
})

describe('listRuns attaches the tree total', () => {
  test('a parent reports both its own cost and its tree cost', async () => {
    const { parentId, children } = await fanOut(2)
    await agentStep(parentId, 1_000)
    for (const c of children) await agentStep(c, 1_000_000)

    const { rows } = await listRuns(db, {})

    expect(rows[0]?.id).toBe(parentId)
    // Both, deliberately: the own figure is what this instance did, the tree
    // figure is what the upload cost, and each answers a different question.
    expect(rows[0]?.totalTokens).toBe(1_000)
    expect(rows[0]?.tree?.totalTokens).toBe(2_001_000)
  })

  test('a childless run carries no tree at all', async () => {
    const runId = await createRun(db, base)
    await agentStep(runId, 5)

    const { rows } = await listRuns(db, {})

    // Null rather than a tree of one: a row that has nothing beneath it should
    // not make the reader compare two identical numbers to discover that.
    expect(rows[0]?.tree).toBeNull()
    expect(rows[0]?.costUsd).not.toBeNull()
  })
})

describe('loadRunStats', () => {
  test('prices a sample by its whole tree, not just the parent row', async () => {
    const { parentId, children } = await fanOut(2)
    for (const c of children) await agentStep(c, 500_000, { seconds: 3 })

    const stats = (await loadRunStats(db, [parentId])).get(parentId)

    // An eval whose target fans out durably would otherwise compare samples on
    // the parent's near-zero cost, which has nothing to do with what they cost.
    expect(stats?.totalTokens).toBe(1_000_000)
    expect(stats?.costUsd).toBeCloseTo(1, 6)
    expect(stats?.durationMs).toBe(6_000)
  })

  test('falls back to the run wall clock when no agent step recorded timing', async () => {
    const runId = await createRun(db, base)
    await agentStep(runId, 10)
    await settle(runId, 'completed', 7)

    expect((await loadRunStats(db, [runId])).get(runId)?.durationMs).toBe(7_000)
  })

  test('carries the frozen agent version out of the tree', async () => {
    const { parentId, children } = await fanOut(1)
    await agentStep(children[0], 10, { agentVersion: 4 })

    expect((await loadRunStats(db, [parentId])).get(parentId)?.agentVersion).toBe(4)
  })

  test('a missing run is absent from the map', async () => {
    expect((await loadRunStats(db, ['nope'])).has('nope')).toBe(false)
  })
})
