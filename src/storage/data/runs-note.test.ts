import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import type { WfDb } from '../client'
import { wfRun, wfSchema, wfWorkflow, wfWorkflowVersion } from '../schema'

import { listRuns } from './runs-list'
import { RUN_NOTE_MAX_LENGTH, setRunNote } from './runs-note'

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
  await db.insert(wfRun).values([
    {
      id: 'run-1',
      workflowVersionId: 'v-1',
      triggerKind: 'chat',
      status: 'failed',
    },
    {
      id: 'run-2',
      workflowVersionId: 'v-1',
      triggerKind: 'chat',
      status: 'completed',
    },
  ])
})

async function noteOf(runId: string): Promise<string | null> {
  const { rows } = await listRuns(db, {})
  return rows.find((r) => r.id === runId)?.note ?? null
}

describe('setRunNote', () => {
  test('writes, overwrites, and clears — last write wins', async () => {
    expect(await setRunNote(db, { runId: 'run-1', note: '**timeout**' })).toBe(
      true,
    )
    expect(await noteOf('run-1')).toBe('**timeout**')

    // Anyone can edit anyone's note; there is no ownership check to trip over.
    await setRunNote(db, { runId: 'run-1', note: 'actually a bad prompt' })
    expect(await noteOf('run-1')).toBe('actually a bad prompt')

    await setRunNote(db, { runId: 'run-1', note: null })
    expect(await noteOf('run-1')).toBeNull()
  })

  test('leaves other runs alone', async () => {
    await setRunNote(db, { runId: 'run-1', note: 'mine' })
    expect(await noteOf('run-2')).toBeNull()
  })

  test('reports a miss rather than silently succeeding', async () => {
    expect(await setRunNote(db, { runId: 'nope', note: 'x' })).toBe(false)
  })

  test('truncates a note past the cap instead of rejecting it', async () => {
    await setRunNote(db, { runId: 'run-1', note: 'x'.repeat(20_000) })
    expect((await noteOf('run-1'))?.length).toBe(RUN_NOTE_MAX_LENGTH)
  })
})

describe('listRuns search', () => {
  test('matches on the note, so a note is how you find a run again', async () => {
    await setRunNote(db, { runId: 'run-1', note: 'R2 threw a 503 on upload' })
    await setRunNote(db, { runId: 'run-2', note: 'expected — bad fixture' })

    const hit = await listRuns(db, { search: '503' })
    expect(hit.rows.map((r) => r.id)).toEqual(['run-1'])
    expect(hit.total).toBe(1)

    // Still matches the other searchable columns.
    expect((await listRuns(db, { search: 'Intake' })).total).toBe(2)
    expect((await listRuns(db, { search: 'no such text' })).total).toBe(0)
  })
})
