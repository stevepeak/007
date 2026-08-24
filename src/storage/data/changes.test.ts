import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import type { WfDb } from '../client'
import { wfSchema } from '../schema'

import { changesBetween, listChanges, recordChange } from './changes'

// Runs against the real migrations, so these also assert that 0026 applies.
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
beforeEach(() => {
  db = freshDb()
})

const steve = { userId: 'user_steve' }

describe('recordChange', () => {
  test('records who changed what, and to what', async () => {
    await recordChange(db, {
      entityKind: 'eval_row',
      entityId: 'row-1',
      parentId: 'set-1',
      action: 'update',
      fields: ['checks'],
      before: { checks: [] },
      after: { checks: ['a'] },
      actor: steve,
    })

    const [row] = await listChanges(db)
    expect(row.entityKind).toBe('eval_row')
    expect(row.entityId).toBe('row-1')
    expect(row.parentId).toBe('set-1')
    expect(row.actorId).toBe('user_steve')
    expect(row.source).toBe('ui')
    expect(row.fields).toEqual(['checks'])
    expect(row.before).toEqual({ checks: [] })
    expect(row.after).toEqual({ checks: ['a'] })
    expect(row.truncated).toBe(false)
  })

  // The whole reason this is wrapped in try/catch: a save must not fail because
  // its audit row did.
  test('never throws when the write fails', async () => {
    const broken = drizzle(new Database(':memory:'), {
      schema: wfSchema,
    }) as unknown as WfDb
    await expect(
      recordChange(broken, {
        entityKind: 'agent',
        entityId: 'a1',
        action: 'update',
        actor: steve,
      }),
    ).resolves.toBeUndefined()
  })

  describe('payload capping', () => {
    test('drops an oversized payload but keeps the row readable', async () => {
      await recordChange(db, {
        entityKind: 'workflow',
        entityId: 'w1',
        action: 'update',
        fields: ['graph'],
        after: { blob: 'x'.repeat(40_000) },
        actor: steve,
      })

      const [row] = await listChanges(db)
      expect(row.truncated).toBe(true)
      expect(row.after).toBeNull()
      // The labels are what make a dropped-payload row worth having.
      expect(row.fields).toEqual(['graph'])
    })

    test('keeps a payload that fits', async () => {
      await recordChange(db, {
        entityKind: 'workflow',
        entityId: 'w1',
        action: 'update',
        after: { name: 'small' },
        actor: steve,
      })
      const [row] = await listChanges(db)
      expect(row.truncated).toBe(false)
      expect(row.after).toEqual({ name: 'small' })
    })
  })

  describe('coalescing', () => {
    const edit = (after: unknown, fields = ['checks']) =>
      recordChange(db, {
        entityKind: 'eval_row',
        entityId: 'row-1',
        action: 'update',
        fields,
        before: { v: 0 },
        after,
        actor: steve,
      })

    test('folds a burst of edits to the same fields into one row', async () => {
      await edit({ v: 1 })
      await edit({ v: 2 })
      await edit({ v: 3 })

      const rows = await listChanges(db)
      expect(rows.length).toBe(1)
      expect(rows[0].after).toEqual({ v: 3 })
    })

    // A folded row spans the whole burst, so it has to reach back to where the
    // burst started — not to the last keystroke before the final save.
    test('keeps the ORIGINAL before across a fold', async () => {
      await recordChange(db, {
        entityKind: 'eval_row',
        entityId: 'row-1',
        action: 'update',
        fields: ['checks'],
        before: { v: 'original' },
        after: { v: 1 },
        actor: steve,
      })
      await recordChange(db, {
        entityKind: 'eval_row',
        entityId: 'row-1',
        action: 'update',
        fields: ['checks'],
        before: { v: 1 },
        after: { v: 2 },
        actor: steve,
      })

      const rows = await listChanges(db)
      expect(rows.length).toBe(1)
      expect(rows[0].before).toEqual({ v: 'original' })
      expect(rows[0].after).toEqual({ v: 2 })
    })

    test('starts a new row when different fields change', async () => {
      await edit({ v: 1 }, ['checks'])
      await edit({ v: 2 }, ['name'])
      expect((await listChanges(db)).length).toBe(2)
    })

    test('treats the same fields in a different order as the same change', async () => {
      await edit({ v: 1 }, ['checks', 'input'])
      await edit({ v: 2 }, ['input', 'checks'])
      expect((await listChanges(db)).length).toBe(1)
    })

    test('never folds two different actors together', async () => {
      await edit({ v: 1 })
      await recordChange(db, {
        entityKind: 'eval_row',
        entityId: 'row-1',
        action: 'update',
        fields: ['checks'],
        after: { v: 2 },
        actor: { userId: 'user_other' },
      })
      expect((await listChanges(db)).length).toBe(2)
    })

    test('never folds two different entities together', async () => {
      await edit({ v: 1 })
      await recordChange(db, {
        entityKind: 'eval_row',
        entityId: 'row-2',
        action: 'update',
        fields: ['checks'],
        after: { v: 2 },
        actor: steve,
      })
      expect((await listChanges(db)).length).toBe(2)
    })

    // A publish carries its own version number and change note; folding two of
    // them would lose one outright.
    test('never folds publishes', async () => {
      for (const n of [1, 2]) {
        await recordChange(db, {
          entityKind: 'agent',
          entityId: 'a1',
          action: 'publish',
          fields: ['model'],
          after: { versionNumber: n },
          actor: steve,
        })
      }
      expect((await listChanges(db)).length).toBe(2)
    })
  })
})

describe('listChanges', () => {
  beforeEach(async () => {
    await recordChange(db, {
      entityKind: 'eval_row',
      entityId: 'row-1',
      parentId: 'set-1',
      action: 'update',
      fields: ['checks'],
      actor: steve,
    })
    await recordChange(db, {
      entityKind: 'agent',
      entityId: 'agent-1',
      action: 'publish',
      fields: ['model'],
      actor: { userId: 'user_other' },
    })
  })

  test('filters by entity', async () => {
    const rows = await listChanges(db, {
      entityKind: 'agent',
      entityId: 'agent-1',
    })
    expect(rows.length).toBe(1)
    expect(rows[0].entityKind).toBe('agent')
  })

  // How a Goal's activity picks up edits to its samples without a second query.
  test('filters by grouping parent', async () => {
    const rows = await listChanges(db, { parentId: 'set-1' })
    expect(rows.length).toBe(1)
    expect(rows[0].entityId).toBe('row-1')
  })

  test('filters by actor', async () => {
    expect((await listChanges(db, { actorId: 'user_steve' })).length).toBe(1)
  })

  test('returns everything with no filter', async () => {
    expect((await listChanges(db)).length).toBe(2)
  })
})

describe('changesBetween', () => {
  test('returns only changes inside the window', async () => {
    const t = (ms: number) => new Date(ms)
    // recordChange stamps `now`, so write directly to control the timestamps.
    const { wfChange } = wfSchema
    await db.insert(wfChange).values([
      {
        entityKind: 'eval_row',
        entityId: 'row-1',
        action: 'update',
        fields: ['checks'],
        createdAt: t(1000),
      },
      {
        entityKind: 'eval_row',
        entityId: 'row-1',
        action: 'update',
        fields: ['input'],
        createdAt: t(5000),
      },
      {
        entityKind: 'eval_row',
        entityId: 'row-1',
        action: 'update',
        fields: ['name'],
        createdAt: t(9000),
      },
    ])

    const rows = await changesBetween(
      db,
      [{ entityKind: 'eval_row', entityIds: ['row-1'] }],
      { from: t(2000), to: t(8000) },
    )
    expect(rows.length).toBe(1)
    expect(rows[0].fields).toEqual(['input'])
  })

  // Ids are opaque, so an eval_row and an agent could in principle collide.
  test('does not match an id belonging to a different kind', async () => {
    await recordChange(db, {
      entityKind: 'agent',
      entityId: 'shared-id',
      action: 'update',
      actor: steve,
    })
    const rows = await changesBetween(
      db,
      [{ entityKind: 'eval_row', entityIds: ['shared-id'] }],
      { from: new Date(0), to: new Date(Date.now() + 10_000) },
    )
    expect(rows.length).toBe(0)
  })

  test('short-circuits when there is nothing to look for', async () => {
    const rows = await changesBetween(
      db,
      [{ entityKind: 'agent', entityIds: [] }],
      { from: new Date(0), to: new Date(Date.now() + 10_000) },
    )
    expect(rows).toEqual([])
  })
})
