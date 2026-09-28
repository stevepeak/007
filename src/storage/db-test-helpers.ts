import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Database } from 'bun:sqlite'
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
