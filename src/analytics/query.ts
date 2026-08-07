// Reading Analytics Engine. There is no read BINDING — AE is queried only over
// its SQL API, which means an HTTPS call with an account-scoped API token from
// whichever Worker serves the dashboard (here, the web app, which does not and
// should not hold the AE dataset binding at all).
//
// Everything below is transport. The SQL itself lives in `./sql.ts` as pure
// string builders so it can be unit-tested without a network.

/** One row of a `FORMAT JSON` result, values already coerced by the caller. */
export type AnalyticsRow = Record<string, unknown>

export interface AnalyticsQuery {
  /** Run one SQL statement and return its rows. Rejects on a non-2xx. */
  run(sql: string): Promise<AnalyticsRow[]>
}

export type CreateAnalyticsQueryOptions = {
  accountId: string
  /** An API token holding **Account Analytics Read**, and nothing more. */
  apiToken: string
  /** The dataset name, i.e. the SQL table. Validated — it is interpolated. */
  dataset: string
  /** Injectable for tests. */
  fetchImpl?: typeof fetch
}

/**
 * The SQL API takes a raw statement with NO parameter binding, so the dataset
 * name is interpolated into every query. It comes from host config rather than
 * the wire, but validating it here means a typo fails loudly at construction
 * instead of producing a syntactically valid query against something else.
 */
const DATASET_NAME = /^\w+$/

export function assertDatasetName(dataset: string): string {
  if (!DATASET_NAME.test(dataset)) {
    throw new Error(
      `Invalid Analytics Engine dataset name ${JSON.stringify(dataset)} — expected letters, digits and underscores only.`,
    )
  }
  return dataset
}

type SqlApiResponse = { data?: AnalyticsRow[]; rows?: number }

export function createAnalyticsQuery(
  opts: CreateAnalyticsQueryOptions,
): AnalyticsQuery {
  assertDatasetName(opts.dataset)
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/analytics_engine/sql`
  const doFetch = opts.fetchImpl ?? fetch

  return {
    async run(sql) {
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.apiToken}`,
          'Content-Type': 'text/plain',
        },
        body: sql,
      })
      if (!res.ok) {
        // Include the body: AE reports schema errors (an ordinal that doesn't
        // exist yet, a dataset with no rows) as plain text, and the status
        // alone is not enough to tell those apart from an auth failure.
        const detail = await res.text().catch(() => '')
        throw new Error(
          `Analytics Engine query failed (${res.status}): ${detail.slice(0, 500)}`,
        )
      }
      const json: SqlApiResponse = await res.json()
      return json.data ?? []
    },
  }
}

/** Coerce a SQL-API value to a number — aggregates can arrive as strings. */
export function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * Coerce a SQL-API value to a string. Anything that isn't already a string or a
 * number becomes '' rather than "[object Object]" — a dimension that arrived in
 * an unexpected shape should read as absent, not as a bogus group key.
 */
export function str(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value)
  }
  return ''
}
