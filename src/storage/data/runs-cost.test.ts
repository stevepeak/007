import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import type { WfDb } from '../client'
import { wfRun, wfSchema, wfModel } from '../schema'

import { getRunStatus } from './runs-inspector'
import { invalidateModelPriceMap, loadModelPriceMap } from './runs-cost'

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

async function addModel(db: WfDb, id: string, modelId: string, price: number) {
  await db.insert(wfModel).values({
    id,
    providerId: 'venice',
    modelId,
    label: id,
    costPerMTok: price,
    promptPricePerMTok: price,
    completionPricePerMTok: price,
  })
}

describe('loadModelPriceMap', () => {
  let db: WfDb

  beforeEach(() => {
    // No memo reset needed: the cache is keyed by the underlying driver, so a
    // fresh database is automatically a fresh entry. That property is what
    // stops a warm map leaking between test files, so assert it below.
    db = freshDb()
  })

  test('a fresh database never inherits another handle’s cached map', async () => {
    await addModel(db, 'venice:a', 'a', 1)
    await loadModelPriceMap(db)

    const other = freshDb()
    await addModel(other, 'venice:z', 'z', 9)
    const otherMap = await loadModelPriceMap(other)

    expect(otherMap.has('a')).toBe(false)
    expect(otherMap.get('z')?.blendedPerMTok).toBe(9)
  })

  test('two handles over the same driver share the memo', async () => {
    await addModel(db, 'venice:a', 'a', 1)
    const first = await loadModelPriceMap(db)
    // `createWfDb` mints a new drizzle wrapper per request in production; the
    // cache has to survive that or it would never hit.
    const sameDriver = drizzle((db as unknown as { $client: Database }).$client, {
      schema: wfSchema,
    }) as unknown as WfDb
    expect(await loadModelPriceMap(sameDriver)).toBe(first)
  })

  test('keys each model by both its native and composite id', async () => {
    await addModel(db, 'venice:qwen3-9b', 'qwen3-9b', 2)
    const map = await loadModelPriceMap(db)
    expect(map.get('qwen3-9b')?.blendedPerMTok).toBe(2)
    expect(map.get('venice:qwen3-9b')?.blendedPerMTok).toBe(2)
  })

  test('serves a second call from the memo instead of re-scanning', async () => {
    await addModel(db, 'venice:a', 'a', 1)
    const first = await loadModelPriceMap(db)
    expect(first.get('a')?.blendedPerMTok).toBe(1)

    // A row landing after the first load must NOT show up while the memo is
    // warm — that staleness is the whole point of the cache.
    await addModel(db, 'venice:b', 'b', 5)
    const second = await loadModelPriceMap(db)
    expect(second).toBe(first)
    expect(second.has('b')).toBe(false)
  })

  test('invalidateModelPriceMap forces the next load to re-read', async () => {
    await addModel(db, 'venice:a', 'a', 1)
    const first = await loadModelPriceMap(db)

    await addModel(db, 'venice:b', 'b', 5)
    invalidateModelPriceMap(db)
    const second = await loadModelPriceMap(db)

    expect(second).not.toBe(first)
    expect(second.get('b')?.blendedPerMTok).toBe(5)
    expect(second.get('a')?.blendedPerMTok).toBe(1)
  })
})

describe('getRunStatus', () => {
  let db: WfDb

  beforeEach(() => {
    db = freshDb()
  })

  test('returns the three settle fields for an existing run', async () => {
    await db.insert(wfRun).values({
      id: 'run-1',
      workflowVersionId: 'ver-1',
      triggerKind: 'chat',
      status: 'done',
      output: { text: 'the answer' },
    })

    const r = await getRunStatus(db, 'run-1')
    expect(r?.status).toBe('done')
    expect(r?.output).toEqual({ text: 'the answer' })
    expect(r?.error).toBeNull()
  })

  test('surfaces the error text on a failed run', async () => {
    await db.insert(wfRun).values({
      id: 'run-2',
      workflowVersionId: 'ver-1',
      triggerKind: 'chat',
      status: 'failed',
      error: 'boom',
    })

    const r = await getRunStatus(db, 'run-2')
    expect(r?.status).toBe('failed')
    expect(r?.error).toBe('boom')
  })

  test('returns null for an unknown run id', async () => {
    expect(await getRunStatus(db, 'nope')).toBeNull()
  })
})
