import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'
import { inArray } from 'drizzle-orm'

import { D1_LIMITS, freshD1, freshDb, migratedSqlite } from './db-test-helpers'
import { wfRun, wfWorkflow, wfWorkflowVersion } from './schema'

// The guard on the consolidation, not on the helper's mechanics.
//
// 27 test files each carried their own copy of this migration walk, which meant
// a change to the migration FORMAT was a 27-file edit and test #28 inherited
// whichever copy its author happened to open. Nothing stops copy #28 from being
// written except a test that notices, so: this one.

const SRC = fileURLToPath(new URL('..', import.meta.url))

// Assembled rather than written out, so this file is not its own counterexample.
const BREAKPOINT = ['statement', 'breakpoint'].join('-')

function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    .filter((f) => f !== 'storage/db-test-helpers.ts')
}

describe('the shared migrated-sqlite helper', () => {
  test('is the only place that knows how migrations are split', () => {
    const forked = sourceFiles().filter((f) => {
      return readFileSync(`${SRC}${f}`, 'utf8').includes(BREAKPOINT)
    })
    expect(
      forked,
      `These files walk the migration files themselves. Import { freshDb } from ` +
        `'storage/db-test-helpers' instead — and if it doesn't cover the case, ` +
        `extend it (AGENTS.md §5).`,
    ).toEqual([])
  })

  test('applies every migration, so the schema is the real one', async () => {
    const db = freshDb()
    // A write that spans three tables with foreign keys and a JSON column —
    // an unapplied migration fails here rather than in whichever test happens
    // to touch the missing table first.
    await db.insert(wfWorkflow).values({ id: 'wf-1', name: 'Intake' })
    await db
      .insert(wfWorkflowVersion)
      .values({ id: 'v-1', workflowId: 'wf-1', versionNumber: 1, graph: {} })
    await db.insert(wfRun).values({
      id: 'run-1',
      workflowVersionId: 'v-1',
      triggerKind: 'manual',
      status: 'completed',
    })
    expect(await db.select().from(wfRun)).toHaveLength(1)
  })

  test('hands out a fresh database each call', async () => {
    const a = freshDb()
    await a.insert(wfWorkflow).values({ id: 'wf-1', name: 'Intake' })
    expect(await freshDb().select().from(wfWorkflow)).toEqual([])
  })

  test('exposes the raw handle, already migrated', () => {
    const row = migratedSqlite()
      .query("select count(*) as n from sqlite_master where type = 'table'")
      .get() as { n: number }
    expect(row.n).toBeGreaterThan(0)
  })
})

// A query that breaks on D1 has to break here too, or CI passes code that
// production rejects.
describe('freshDb enforces D1 limits', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `wf-${i}`)

  test('rejects a statement binding more than 100 parameters', async () => {
    const db = freshDb()
    // A Drizzle query is a lazy thenable; `.then` is what runs it.
    const query = (n: number) => {
      return db
        .select()
        .from(wfWorkflow)
        .where(inArray(wfWorkflow.id, ids(n)))
        .then((rows) => rows)
    }
    await expect(query(D1_LIMITS.boundParams)).resolves.toEqual([])
    await expect(query(D1_LIMITS.boundParams + 1)).rejects.toThrow(
      'too many SQL variables',
    )
  })

  test('rejects a value larger than D1 stores', async () => {
    const db = freshDb()
    const name = 'x'.repeat(D1_LIMITS.valueBytes + 1)
    await expect(
      db.insert(wfWorkflow).values({ id: 'wf-1', name }).then(() => null),
    ).rejects.toThrow(
      'string or blob too big',
    )
  })

  test('rejects an interactive transaction', () => {
    const db = freshDb()
    expect(() => db.transaction(async () => {})).toThrow(
      'interactive transactions',
    )
  })

  test('guards the D1 binding facade too', () => {
    const stmt = freshD1()
      .prepare(
        `select * from wf_workflow where id in (${ids(101)
          .map(() => '?')
          .join(',')})`,
      )
      .bind(...ids(101))
    expect(() => stmt.all()).toThrow('too many SQL variables')
  })
})
