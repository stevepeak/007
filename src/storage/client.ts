import type { D1Database } from '@cloudflare/workers-types'
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'
import { drizzle as drizzleProxy } from 'drizzle-orm/sqlite-proxy'

import { wfSchema } from './schema'

// A Drizzle client bound to the SDK's `wf_*` tables only. D1 is a Worker
// binding (`env.DB`), available only inside a request / workflow step — call
// this in the request path, never at module load. `D1Database` is imported
// explicitly (not from the ambient workers-types globals) so consumers whose
// tsconfig omits those globals (a Next app on the DOM lib) can import this too.
export type WfDb = DrizzleD1Database<typeof wfSchema>

export function createWfDb(d1: D1Database): WfDb {
  return drizzle(d1, { schema: wfSchema })
}

export interface CreateWfDbHttpOptions {
  accountId: string
  databaseId: string
  token: string
}

interface D1RawResponse {
  success: boolean
  errors?: unknown
  result?: { results?: { rows?: unknown[][] } }[]
}

/**
 * A {@link WfDb} that talks to D1 over its REST API — for Node contexts with no
 * Worker binding (CLI scripts, CI). Mirrors `@app/db`'s `createDbHttp` but binds
 * the `wf_*` schema. `db.batch()` is not wired (the proxy needs a batch
 * callback), so callers must issue statements individually — which the SDK's
 * seed/data helpers already do.
 */
export function createWfDbHttp(opts: CreateWfDbHttpOptions): WfDb {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/d1/database/${opts.databaseId}/raw`

  return drizzleProxy(
    async (query, params, method) => {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sql: query, params }),
      })
      const json: unknown = await res.json()
      const data = json as D1RawResponse
      if (!res.ok || !data.success) {
        throw new Error(`D1 HTTP query failed: ${JSON.stringify(data.errors)}`)
      }
      // The `/raw` endpoint returns rows as arrays of column values — exactly
      // the shape sqlite-proxy expects.
      const rows = data.result?.[0]?.results?.rows ?? []
      return { rows: method === 'get' ? (rows[0] ?? []) : rows }
    },
    { schema: wfSchema },
  ) as unknown as WfDb
}
