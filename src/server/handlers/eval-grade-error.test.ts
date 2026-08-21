import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import type { WfDb } from '../../storage/client'
import { createEvalRun, createEvalSet, getEvalRun, upsertEvalRow } from '../../storage/data'
import { wfRun, wfSchema } from '../../storage/schema'
import type { CreateWfSdkHandlersOptions } from './shared'
import type { HandlerCtx } from './shared'

import { buildEvalHandlers } from './evals'

// A graded row that ERRORS has no per-check verdict explaining itself, so its
// reason has to reach the result's `error` column or the report renders a red
// cell above an empty banner. This is the end-to-end proof of that chain:
// gradeRow → the handler's record → the persisted column → the DTO.

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

function options(): CreateWfSdkHandlersOptions<unknown> {
  return {
    config: {
      // Never consulted: a row with no checks short-circuits before any judge.
      listModels: async () => [],
      getModel: () => {
        throw new Error('no model should be needed to grade an empty tree')
      },
    },
    resolveDb: () => {
      throw new Error('unused')
    },
    resolveContext: () => ({}),
  } as unknown as CreateWfSdkHandlersOptions<unknown>
}

function ctx(db: WfDb, params: unknown): HandlerCtx {
  return {
    params,
    ctx: { userId: 'tester' },
    db,
    req: new Request('http://localhost/api/wf', { method: 'POST' }),
    env: async () => ({}),
    analytics: async () => null,
  } as unknown as HandlerCtx
}

describe('gradeEvalResult — an unasserted sample', () => {
  let db: WfDb

  beforeEach(() => {
    db = freshDb()
  })

  test('records status=error AND the reason, on the result and its DTO', async () => {
    const setId = await createEvalSet(db, {
      name: 'Goal',
      targetKind: 'agent',
      targetId: 'agent-1',
      targetVersion: null,
      triggerKind: 'manual',
    })
    const rowId = await upsertEvalRow(db, {
      setId,
      name: 'Untitled sample',
      // The whole point: a sample nobody finished authoring.
      checks: { op: 'and', checks: [] },
    })
    const evalRunId = await createEvalRun(db, { setIds: [setId], total: 1 })

    const wfRunId = crypto.randomUUID()
    await db.insert(wfRun).values({
      id: wfRunId,
      workflowVersionId: 'v-1',
      triggerKind: 'manual',
      status: 'completed',
      output: { text: 'anything at all' },
    })

    const handlers = buildEvalHandlers(options())
    const dto = await handlers.gradeEvalResult(
      ctx(db, { evalRunId, rowId, wfRunId }),
    )

    // The DTO the editor gets back...
    expect(dto).toMatchObject({ status: 'error' })
    expect((dto as { error: string | null }).error).toContain('no checks')

    // ...and the row that the report will later read.
    const stored = await getEvalRun(db, evalRunId)
    expect(stored?.results).toHaveLength(1)
    expect(stored?.results[0]?.status).toBe('error')
    expect(stored?.results[0]?.error).toContain('no checks')
  })
})
