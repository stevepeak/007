import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import type { WfDb } from '../client'
import { wfSchema } from '../schema'

import {
  cancelEvalRun,
  createEvalRun,
  createEvalSet,
  deleteEvalRow,
  getEvalRow,
  getEvalRun,
  getEvalSet,
  restoreEvalRow,
  updateEvalRun,
  upsertEvalRow,
} from './evals'

// What these pin is the difference between an UPDATE and a RESET.
//
// `upsertEvalRow` used to default its three JSON columns on the update path, so
// the obvious way to rename a Sample — pass its id and a new name — reset the
// input, reset the tools, and deleted every check. A 0-check Sample then grades
// as `error` rather than failing, so the damage showed up in the next report as
// an infrastructure problem and not as a lost test. Nothing in the console hit
// it (the editor always sends the whole row), which is exactly why it survived.

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
let setId: string

const CHECKS = {
  op: 'and' as const,
  checks: [
    { type: 'tool_called' as const, toolId: 'search_rag', called: true },
    { type: 'llm_judge' as const, rubric: 'Cites the statute.' },
  ],
}

beforeEach(async () => {
  db = freshDb()
  setId = await createEvalSet(db, {
    name: 'Conflict check',
    targetKind: 'agent',
    targetId: 'ag-1',
    triggerKind: 'manual',
  })
})

async function seedRow(): Promise<string> {
  return await upsertEvalRow(db, {
    setId,
    name: 'Refuses out of scope',
    input: { kind: 'task', variables: { matterName: 'Acme v. Byrne' } },
    tools: { mode: 'mocked', fixtures: { search_rag: { hits: [] } } },
    checks: CHECKS,
    sortOrder: 2,
  })
}

describe('upsertEvalRow — omitting a field', () => {
  test('a rename keeps the input, the tools and every check', async () => {
    const rowId = await seedRow()

    // The exact call that used to be destructive.
    await upsertEvalRow(db, { id: rowId, setId, name: 'Refuses politely' })

    const found = await getEvalRow(db, rowId)
    expect(found?.row.name).toBe('Refuses politely')
    expect(found?.row.checks.checks).toHaveLength(2)
    expect(found?.row.input).toEqual({
      kind: 'task',
      variables: { matterName: 'Acme v. Byrne' },
    })
    expect(found?.row.tools).toEqual({
      mode: 'mocked',
      fixtures: { search_rag: { hits: [] } },
    })
    // Not part of the merge, but it rode on the same call and would have been a
    // second silent reset.
    expect(found?.row.sortOrder).toBe(2)
  })

  test('replaces only the field that was passed', async () => {
    const rowId = await seedRow()
    await upsertEvalRow(db, {
      id: rowId,
      setId,
      name: 'Refuses out of scope',
      tools: { mode: 'frozen' },
    })
    const found = await getEvalRow(db, rowId)
    expect(found?.row.tools).toEqual({ mode: 'frozen' })
    // The other two are untouched.
    expect(found?.row.checks.checks).toHaveLength(2)
    expect((found?.row.input as { variables: unknown }).variables).toEqual({
      matterName: 'Acme v. Byrne',
    })
  })

  test('clearing is still possible — by passing the empty value', async () => {
    const rowId = await seedRow()
    await upsertEvalRow(db, {
      id: rowId,
      setId,
      name: 'Refuses out of scope',
      checks: { op: 'and', checks: [] },
    })
    const found = await getEvalRow(db, rowId)
    expect(found?.row.checks.checks).toEqual([])
  })

  test('a create with nothing passed still gets the documented defaults', async () => {
    const rowId = await upsertEvalRow(db, { setId, name: 'Bare' })
    const found = await getEvalRow(db, rowId)
    expect(found?.row.input).toEqual({ kind: 'task', variables: {} })
    expect(found?.row.tools).toEqual({ mode: 'mocked', fixtures: {} })
    expect(found?.row.checks).toEqual({ op: 'and', checks: [] })
  })
})

describe('archiving a Sample is reversible', () => {
  test('an archived row leaves the Goal but is still readable and restorable', async () => {
    const rowId = await seedRow()
    await deleteEvalRow(db, rowId)

    // Gone from the default read — which is what "drops out of its Goal" means.
    const hidden = await getEvalSet(db, setId)
    expect(hidden?.rows).toHaveLength(0)

    // Still there when asked for, which is what makes "nothing is erased" true.
    const shown = await getEvalSet(db, setId, { includeArchived: true })
    expect(shown?.rows).toHaveLength(1)
    expect(shown?.rows[0]?.archived).toBe(true)
    // And the checks survived the archive, so restoring gets the test back
    // rather than an empty shell.
    expect(shown?.rows[0]?.checks.checks).toHaveLength(2)

    await restoreEvalRow(db, rowId)
    const back = await getEvalSet(db, setId)
    expect(back?.rows).toHaveLength(1)
    expect(back?.rows[0]?.archived).toBe(false)
  })

  test('getEvalRow hides an archived row unless asked — the grading path', async () => {
    const rowId = await seedRow()
    await deleteEvalRow(db, rowId)
    // `startEvalRun` / `gradeEvalResult` read through here, and must not launch a
    // Sample that was archived mid-sweep.
    expect(await getEvalRow(db, rowId)).toBeNull()
    expect(
      (await getEvalRow(db, rowId, { includeArchived: true }))?.row.id,
    ).toBe(rowId)
  })
})

describe('cancelEvalRun', () => {
  test('stops a running sweep and keeps the verdicts it already has', async () => {
    const evalRunId = await createEvalRun(db, { setIds: [setId], total: 10 })
    await updateEvalRun(db, { evalRunId, status: 'running' })

    expect(await cancelEvalRun(db, evalRunId)).toBe(true)
    const found = await getEvalRun(db, evalRunId)
    expect(found?.run.status).toBe('cancelled')
    expect(found?.run.finishedAt).not.toBeNull()
    // The heartbeat is cleared, but the status predicate in `listStaleEvalRuns`
    // is what actually keeps the backstop from adopting it again.
    expect(found?.run.heartbeatAt).toBeNull()
    // `total` stays at what was requested; the gap to the result count is the
    // record of what was called off.
    expect(found?.run.total).toBe(10)
  })

  test('refuses to rewrite a run that already finished', async () => {
    const evalRunId = await createEvalRun(db, { setIds: [setId], total: 2 })
    await updateEvalRun(db, { evalRunId, status: 'completed' })

    expect(await cancelEvalRun(db, evalRunId)).toBe(false)
    // Writing `cancelled` over a finished report would rewrite its history.
    expect((await getEvalRun(db, evalRunId))?.run.status).toBe('completed')
  })
})
