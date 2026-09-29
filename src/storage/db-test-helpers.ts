import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { D1Database } from '@cloudflare/workers-types'
import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import type { WfDb } from './client'
import { wfSchema } from './schema'

// The migrated in-memory database every DB-backed test runs against.
//
// This used to be a `freshDb()` copied into 27 test files — each one re-deriving
// the migration walk (read the dir, split on the drizzle breakpoint, skip the
// blanks) and each one free to drift. The walk is a property of the migration
// FORMAT, not of any one test: a new `.sql` that must be skipped, a different
// breakpoint marker, or a seed row every test needs is a change to drizzle's
// output, and it should cost one edit here rather than 27 there.
//
// `db-test-helpers.test.ts` guards the consolidation: a test file that spells
// the breakpoint marker itself has forked the walk again.
//
// Real migrations, not `schema` push: the tests below assert on indexes,
// defaults and generated columns that only the migration files carry, and a
// migration that doesn't apply cleanly should fail the suite rather than be
// papered over by a schema the DB never actually saw.

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../migrations', import.meta.url),
)

/**
 * An in-memory SQLite database with every migration applied, as the raw
 * `bun:sqlite` handle.
 *
 * Reach for this only when a test needs the handle itself — `param-budget`
 * proxies it to count bound parameters. Everything else wants {@link freshDb}.
 */
export function migratedSqlite(): Database {
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
  return sqlite
}

/**
 * Wrap a `bun:sqlite` handle as a {@link WfDb}.
 *
 * The cast is the seam between the two drivers: production binds Drizzle to D1
 * (`DrizzleD1Database`), tests bind the same schema to bun's synchronous SQLite.
 * The query surface the data helpers use is identical; the driver types are not,
 * and no amount of generics makes them so.
 */
export function wrapSqlite(sqlite: Database): WfDb {
  return drizzle(sqlite, { schema: wfSchema }) as unknown as WfDb
}

/** A migrated, empty {@link WfDb}. One per test — `:memory:` makes it cheap. */
export function freshDb(): WfDb {
  return wrapSqlite(migratedSqlite())
}

/**
 * A {@link D1Database}-shaped facade over a `bun:sqlite` handle.
 *
 * {@link freshDb} is the right answer whenever a test can hold a {@link WfDb}
 * directly. This exists for the handful of places that CANNOT: the Cloudflare
 * dispatch calls `createWfDb(env.WF_DB)` from inside its own `step.do` closures,
 * on purpose (a D1 binding is cheap to re-wrap and the closure replays), so the
 * only way to give that code a database is to hand it a binding.
 *
 * Only the four calls drizzle-d1 actually makes are implemented — `prepare`,
 * `bind`, `run`/`all`/`raw`, and `batch`. `batch` is NOT atomic here (bun's
 * SQLite runs the statements in sequence), which production's binding is; a test
 * asserting all-or-nothing rollback wants the real thing, not this.
 */
export function d1FromSqlite(sqlite: Database): D1Database {
  const bound = (sql: string, params: unknown[]) => {
    const stmt = () => sqlite.prepare(sql)
    const args = () => params as SQLQueryBindings[]
    return {
      bind: (...next: unknown[]) => bound(sql, next),
      run: () => {
        const r = stmt().run(...args())
        return Promise.resolve({
          success: true,
          results: [],
          meta: {
            changes: r.changes,
            last_row_id: Number(r.lastInsertRowid),
            rows_read: 0,
            rows_written: r.changes,
          },
        })
      },
      all: () => {
        return Promise.resolve({
          success: true,
          results: stmt().all(...args()) as Record<string, unknown>[],
          meta: {},
        })
      },
      raw: () => Promise.resolve(stmt().values(...args()) as unknown[][]),
      first: (column?: string) => {
        const row = stmt().get(...args()) as Record<string, unknown> | null
        if (!row) return Promise.resolve(null)
        return Promise.resolve(column == null ? row : (row[column] ?? null))
      },
    }
  }
  const client = {
    prepare: (sql: string) => bound(sql, []),
    batch: (statements: { all: () => Promise<unknown> }[]) => {
      // Sequential, not concurrent: these are writes against one connection and
      // a later statement in a batch may depend on an earlier one.
      return statements.reduce<Promise<unknown[]>>(async (acc, s) => {
        const done = await acc
        return [...done, await s.all()]
      }, Promise.resolve([]))
    },
  }
  return client as unknown as D1Database
}

/** A migrated, empty database as a {@link D1Database} binding. */
export function freshD1(): D1Database {
  return d1FromSqlite(migratedSqlite())
}
