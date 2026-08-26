import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import type { WfDb } from '../client'
import {
  TOP_LEVEL_ITEM_INDEX,
  wfRun,
  wfSchema,
  wfWorkflow,
  wfWorkflowVersion,
} from '../schema'

import { createRun } from './runs-lifecycle'

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

beforeEach(async () => {
  db = freshDb()
  await db.insert(wfWorkflow).values({ id: 'wf-1', name: 'Intake' })
  await db
    .insert(wfWorkflowVersion)
    .values({ id: 'v-1', workflowId: 'wf-1', versionNumber: 1, graph: {} })
})

const base = { workflowVersionId: 'v-1', triggerKind: 'chat' }

async function read(id: string) {
  const [row] = await db.select().from(wfRun).where(eq(wfRun.id, id)).limit(1)
  return row
}

describe('parent linkage on wf_run', () => {
  test('a run created without a parent reads as top-level', async () => {
    const row = await read(await createRun(db, base))

    expect(row?.parentRunId).toBeNull()
    expect(row?.parentNodeId).toBeNull()
    // Never NULL — the sentinel is what lets the children query order by it
    // and lets `parent_run_id IS NULL` alone mean "top-level".
    expect(row?.itemIndex).toBe(TOP_LEVEL_ITEM_INDEX)
  })

  test('a workflow-call callee links to its caller and node', async () => {
    const parentId = await createRun(db, base)
    const row = await read(
      await createRun(db, {
        ...base,
        parent: { runId: parentId, nodeId: 'node-call' },
      }),
    )

    expect(row?.parentRunId).toBe(parentId)
    expect(row?.parentNodeId).toBe('node-call')
    // One callee per workflow-call node, so it takes the sentinel rather than 0
    // — 0 would claim it was the first of several iteration items.
    expect(row?.itemIndex).toBe(TOP_LEVEL_ITEM_INDEX)
  })

  test('iteration items keep their 0-based index and list in order', async () => {
    const parentId = await createRun(db, base)
    // Deliberately out of order: the index, not insertion order, must drive it.
    for (const itemIndex of [2, 0, 1]) {
      await createRun(db, {
        ...base,
        parent: { runId: parentId, nodeId: 'node-iter', itemIndex },
      })
    }

    const children = await db
      .select()
      .from(wfRun)
      .where(eq(wfRun.parentRunId, parentId))
      .orderBy(asc(wfRun.itemIndex))

    expect(children.map((c) => c.itemIndex)).toEqual([0, 1, 2])
    expect(children.every((c) => c.parentNodeId === 'node-iter')).toBe(true)
  })

  test('children are excluded from a top-level listing', async () => {
    const parentId = await createRun(db, base)
    await createRun(db, {
      ...base,
      parent: { runId: parentId, nodeId: 'node-iter', itemIndex: 0 },
    })

    const topLevel = await db
      .select({ id: wfRun.id })
      .from(wfRun)
      .where(and(isNull(wfRun.parentRunId), eq(wfRun.workflowVersionId, 'v-1')))

    expect(topLevel.map((r) => r.id)).toEqual([parentId])
  })
})
