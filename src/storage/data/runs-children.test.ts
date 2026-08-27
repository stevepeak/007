import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import type { WfDb } from '../client'
import { wfRun, wfSchema, wfWorkflow, wfWorkflowVersion } from '../schema'

import { countChildRuns, listChildRuns } from './runs-children'
import { createRun } from './runs-lifecycle'
import { listRuns } from './runs-list'

// The nested-runs reads (NEW-176). `listRuns`' top-level predicate and its
// parent-or-child match are hand-written SQL — an alias-scoped EXISTS and a
// correlated NOT EXISTS — so these tests EXECUTE them rather than asserting on
// a built query object. A typo in either reads as a valid query returning the
// wrong set, which no amount of typechecking catches.

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
  await db
    .insert(wfWorkflow)
    .values([
      { id: 'wf-parent', name: 'Ingest document' },
      { id: 'wf-callee', name: 'Enrich prices' },
    ])
  await db.insert(wfWorkflowVersion).values([
    { id: 'v-parent', workflowId: 'wf-parent', versionNumber: 1, graph: {} },
    { id: 'v-callee', workflowId: 'wf-callee', versionNumber: 3, graph: {} },
  ])
})

const parentBase = { workflowVersionId: 'v-parent', triggerKind: 'upload' }

async function setStatus(runId: string, status: 'completed' | 'failed' | 'running') {
  await db.update(wfRun).set({ status }).where(eq(wfRun.id, runId))
}

/** A parent with `n` durable iteration items beneath it. */
async function fanOut(n: number, nodeId = 'iter-1') {
  const parentId = await createRun(db, parentBase)
  const children: string[] = []
  for (let i = 0; i < n; i++) {
    children.push(
      await createRun(db, {
        ...parentBase,
        parent: { runId: parentId, nodeId, itemIndex: i },
      }),
    )
  }
  return { parentId, children }
}

describe('listRuns nests children under their parent', () => {
  test('children do not appear as top-level rows', async () => {
    const { parentId } = await fanOut(3)

    const { rows, total } = await listRuns(db, {})

    expect(rows.map((r) => r.id)).toEqual([parentId])
    // The unpaginated total shares the same predicate — a count that still
    // said 4 would make the pager offer pages that render empty.
    expect(total).toBe(1)
  })

  test('a parent carries its child counts', async () => {
    const { parentId, children } = await fanOut(3)
    await setStatus(children[0], 'completed')
    await setStatus(children[1], 'failed')

    const { rows } = await listRuns(db, {})

    expect(rows[0]?.id).toBe(parentId)
    expect(rows[0]?.children).toEqual({ total: 3, settled: 2, failed: 1 })
  })

  test('a run with no children reports null, not a zeroed row', async () => {
    await createRun(db, parentBase)

    const { rows } = await listRuns(db, {})

    // Distinguishable from a fan-out that produced nothing, so the UI can show
    // no chip at all rather than "0 items".
    expect(rows[0]?.children).toBeNull()
  })

  test('an orphaned child still lists, as top-level', async () => {
    // `deleteWorkflow` removes a caller's runs but not the runs of the OTHER
    // workflows it spawned, so a dangling parent_run_id is reachable in
    // practice — and must not make a run vanish from the explorer.
    const { parentId, children } = await fanOut(2)
    await db.delete(wfRun).where(eq(wfRun.id, parentId))

    const { rows } = await listRuns(db, {})

    expect(rows.map((r) => r.id).sort()).toEqual([...children].sort())
  })
})

describe('listRuns matches a parent through its children', () => {
  test('a failed child surfaces its parent even when the parent completed', async () => {
    // The `stopOnError: false` shape: the item failed, the loop filled its slot
    // with a placeholder, and the run finished green. Without descendant
    // matching this failure is invisible in every default view.
    const { parentId, children } = await fanOut(3)
    await setStatus(parentId, 'completed')
    await setStatus(children[1], 'failed')

    const { rows } = await listRuns(db, { status: 'failed' })

    expect(rows.map((r) => r.id)).toEqual([parentId])
  })

  test('a status filter still excludes a tree where nothing matches', async () => {
    const { parentId } = await fanOut(2)
    await setStatus(parentId, 'completed')

    expect((await listRuns(db, { status: 'failed' })).rows).toEqual([])
  })

  test('search finds a parent by the name of the workflow its callee ran', async () => {
    // A workflow-call callee runs a DIFFERENT workflow, so it carries a name
    // its parent does not — the one search term that genuinely only exists on
    // the child.
    const parentId = await createRun(db, parentBase)
    await createRun(db, {
      workflowVersionId: 'v-callee',
      triggerKind: 'upload',
      parent: { runId: parentId, nodeId: 'call-1' },
    })

    const { rows } = await listRuns(db, { search: 'Enrich' })

    expect(rows.map((r) => r.id)).toEqual([parentId])
  })

  test("search on a child's note finds the parent", async () => {
    const { parentId, children } = await fanOut(2)
    await db
      .update(wfRun)
      .set({ note: 'the timeout one' })
      .where(eq(wfRun.id, children[1]))

    expect((await listRuns(db, { search: 'timeout' })).rows.map((r) => r.id)).toEqual([
      parentId,
    ])
  })

  test('scope filters are NOT satisfied by a child', async () => {
    // A child's workflow must not drag its parent into a listing scoped to
    // that workflow — "show me runs of X" means runs OF X, and the parent is
    // a run of something else.
    const parentId = await createRun(db, parentBase)
    await createRun(db, {
      workflowVersionId: 'v-callee',
      triggerKind: 'upload',
      parent: { runId: parentId, nodeId: 'call-1' },
    })

    const { rows } = await listRuns(db, { workflowId: 'wf-callee' })

    expect(rows).toEqual([])
  })
})

describe('listChildRuns', () => {
  test('orders by item index regardless of insertion order', async () => {
    const parentId = await createRun(db, parentBase)
    for (const itemIndex of [2, 0, 3, 1]) {
      await createRun(db, {
        ...parentBase,
        parent: { runId: parentId, nodeId: 'iter-1', itemIndex },
      })
    }

    const kids = await listChildRuns(db, parentId)

    expect(kids.map((k) => k.itemIndex)).toEqual([0, 1, 2, 3])
    expect(kids.every((k) => k.parentNodeId === 'iter-1')).toBe(true)
  })

  test('a callee child reports its own workflow and a null item index', async () => {
    const parentId = await createRun(db, parentBase)
    await createRun(db, {
      workflowVersionId: 'v-callee',
      triggerKind: 'upload',
      parent: { runId: parentId, nodeId: 'call-1' },
    })

    const [callee] = await listChildRuns(db, parentId)

    expect(callee?.workflowName).toBe('Enrich prices')
    expect(callee?.versionNumber).toBe(3)
    // The stored sentinel is -1; the wire shape says "not an iteration item".
    expect(callee?.itemIndex).toBeNull()
  })

  test('carries the item title resolved at spawn', async () => {
    // Stored, not derived: every surface that shows this is a list of siblings
    // built from `wf_run` alone, and the value the title came from lives in the
    // child's own trigger step — one step read per child, on a poll, to render
    // a label.
    const parentId = await createRun(db, parentBase)
    await createRun(db, {
      ...parentBase,
      parent: {
        runId: parentId,
        nodeId: 'iter-1',
        itemIndex: 0,
        itemTitle: 'Chocolate Mousse',
      },
    })
    // No title — the author set no template, or it resolved to nothing.
    await createRun(db, {
      ...parentBase,
      parent: { runId: parentId, nodeId: 'iter-1', itemIndex: 1 },
    })

    const kids = await listChildRuns(db, parentId)

    expect(kids.map((k) => k.itemTitle)).toEqual(['Chocolate Mousse', null])
  })

  test('a run with no children returns an empty list', async () => {
    expect(await listChildRuns(db, await createRun(db, parentBase))).toEqual([])
  })
})

describe('countChildRuns', () => {
  test('counts several parents in one pass and omits childless ones', async () => {
    const a = await fanOut(2, 'iter-a')
    const b = await fanOut(1, 'iter-b')
    const childless = await createRun(db, parentBase)
    await setStatus(a.children[0], 'failed')

    const counts = await countChildRuns(db, [a.parentId, b.parentId, childless])

    expect(counts.get(a.parentId)).toEqual({ total: 2, settled: 1, failed: 1 })
    expect(counts.get(b.parentId)).toEqual({ total: 1, settled: 0, failed: 0 })
    expect(counts.has(childless)).toBe(false)
  })

  test('an empty id list makes no query', async () => {
    expect((await countChildRuns(db, [])).size).toBe(0)
  })
})

describe('includeChildren lists a tree flat', () => {
  test('children become rows of their own', async () => {
    const { parentId, children } = await fanOut(2)

    const { rows } = await listRuns(db, { includeChildren: true })

    expect(rows.map((r) => r.id).sort()).toEqual(
      [parentId, ...children].sort(),
    )
  })

  test('a failed child reports as itself, not as its completed parent', async () => {
    // The dashboard's failures panel. Nested, this failure surfaces as a green
    // parent with no error text; flat, it is its own row.
    const { parentId, children } = await fanOut(2)
    await setStatus(parentId, 'completed')
    await setStatus(children[0], 'failed')

    const { rows } = await listRuns(db, {
      status: 'failed',
      includeChildren: true,
    })

    expect(rows.map((r) => r.id)).toEqual([children[0]])
  })
})
