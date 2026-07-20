import { sql } from 'drizzle-orm'

import type { WfDb } from './client'

/**
 * Probe that the SDK's `wf_*` tables exist in the bound D1, throwing a clear,
 * actionable error if they don't. The failure mode this prevents is silent: an
 * unmigrated D1 surfaces as empty editor lists or an opaque "no such table"
 * from deep inside a query — easy to mistake for an app bug rather than a
 * missing migration.
 *
 * Call it once at startup (or once per process, memoized) in **dev** — it runs
 * a single trivial query, so it's cheap, but there's no need to run it per
 * request. In production the migrations are applied by the deploy pipeline, so
 * you can skip it there.
 *
 * ```ts
 * if (isDev) await assertWfSchema(db) // throws → "run `wrangler d1 migrations apply`"
 * ```
 */
export async function assertWfSchema(db: WfDb): Promise<void> {
  try {
    await db.run(sql`select 1 from wf_workflow limit 1`)
    // Probe an eval table too, so a DB migrated before the evals migration
    // (0006) surfaces the same actionable error rather than a late failure.
    await db.run(sql`select 1 from wf_eval_set limit 1`)
    // Probe the model catalog table, so a DB migrated before the models
    // migration surfaces the same actionable error.
    await db.run(sql`select 1 from wf_model limit 1`)
  } catch (err) {
    throw new Error(
      "@stevepeak/007: the wf_* tables are missing from the bound D1 database. " +
        "Apply the SDK migrations before serving — e.g. `wrangler d1 migrations " +
        "apply <db> --local --persist-to <shared-state>` (see guide §3). " +
        `Underlying error: ${(err as Error).message}`,
    )
  }
}
