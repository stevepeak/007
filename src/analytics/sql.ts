import { TELEMETRY_SCHEMA_VERSION } from './points'

// The dashboard's Analytics Engine queries, as pure string builders.
//
// TWO RULES, both easy to break silently:
//
//  1. SAMPLING. AE samples within an index once a workflow gets busy, and every
//     row then stands for `_sample_interval` real events. A bare `COUNT()` or
//     `SUM(x)` therefore under-reports — silently, and only under load, which is
//     exactly when the number matters. Every count is `SUM(_sample_interval)`
//     and every total is `SUM(_sample_interval * x)`. `sql.test.ts` enforces it.
//
//  2. NO BOUND PARAMETERS. The SQL API takes a raw statement, so every value
//     here is interpolated. Only server-controlled values are ever interpolated:
//     the window is clamped by `resolveWindow` before it reaches this file, the
//     bucket size is 3600 or 86400, and the dataset name is validated by
//     `assertDatasetName`. Nothing from the wire reaches a query string.
//
// Bucketing differs by point type ON PURPOSE:
//   • run volume buckets on `double9` (the run's START, carried on the point),
//     because the point is written at finish and a long run would otherwise land
//     in the wrong bucket and stop reconciling with `wf_run.created_at`;
//   • spend buckets on AE's own `timestamp`, because money belongs to when it
//     was actually spent, not to when its run happened to be created.

export type AnalyticsWindow = {
  /** Window start, epoch SECONDS. */
  sinceSec: number
  /** Window end, epoch SECONDS. */
  untilSec: number
  /** Bucket width in seconds — 3600 or 86400. */
  size: number
}

/**
 * Partition pruning for the run-volume queries. They filter on the CARRIED start
 * time, but AE partitions on ingest `timestamp`; without a timestamp predicate
 * every query would scan the full retention window. A day of slack covers any
 * run that started just before the window and finished inside it.
 */
const INGEST_SLACK_SEC = 86_400

const V = TELEMETRY_SCHEMA_VERSION

/** Run volume + failures per workflow per bucket. Replaces the D1 group-by. */
export function runVolumeSql(dataset: string, w: AnalyticsWindow): string {
  return `SELECT
  blob3 AS workflow_id,
  intDiv(toUInt32(double9), ${w.size}) AS ordinal,
  SUM(_sample_interval) AS runs,
  SUM(IF(blob8 = 'failed', _sample_interval, 0)) AS failed
FROM ${dataset}
WHERE blob1 = 'run' AND blob2 = '${V}'
  AND double1 = 0
  AND double9 >= ${w.sinceSec} AND double9 <= ${w.untilSec}
  AND timestamp >= toDateTime(${w.sinceSec - INGEST_SLACK_SEC})
GROUP BY workflow_id, ordinal
ORDER BY ordinal
FORMAT JSON`
}

/**
 * Spend + tokens per model per bucket — the query this whole exercise exists to
 * replace. The D1 original parses every agent step's full `meta` blob (tool
 * inputs and outputs included) with `json_extract`, over a table with no time
 * index.
 *
 * `cost_usd` was priced when the tokens were spent, so it does NOT move when the
 * model catalog changes. `priced_tokens` separates "cost $0" from "this model
 * has no catalog price", which is what keeps `unpricedTokens` honest.
 */
export function spendSql(dataset: string, w: AnalyticsWindow): string {
  return `SELECT
  intDiv(toUInt32(toUnixTimestamp(timestamp)), ${w.size}) AS ordinal,
  blob11 AS model,
  SUM(_sample_interval * double6) AS input_tokens,
  SUM(_sample_interval * double7) AS output_tokens,
  SUM(_sample_interval * double8) / 1e6 AS cost_usd,
  SUM(_sample_interval * IF(double9 = 1, double6 + double7, 0)) AS priced_tokens
FROM ${dataset}
WHERE blob1 = 'step' AND blob2 = '${V}'
  AND blob9 = 'agent'
  AND double1 = 0
  AND timestamp >= toDateTime(${w.sinceSec}) AND timestamp < toDateTime(${w.untilSec})
GROUP BY ordinal, model
ORDER BY ordinal
FORMAT JSON`
}

/**
 * The Cloudflare Workflows step/storage billing line, per workflow per bucket —
 * the metric with no D1 equivalent, and the reason a graph's cost is not
 * proportional to its node count. Inline runs are excluded: they bill no
 * Workflows steps, and including their zeros would drag every average down.
 */
export function workflowStepsSql(dataset: string, w: AnalyticsWindow): string {
  return `SELECT
  blob3 AS workflow_id,
  intDiv(toUInt32(double9), ${w.size}) AS ordinal,
  SUM(_sample_interval) AS runs,
  SUM(_sample_interval * double6) AS workflow_steps,
  SUM(_sample_interval * double4) AS nodes,
  SUM(_sample_interval * double5) AS iteration_items
FROM ${dataset}
WHERE blob1 = 'run' AND blob2 = '${V}'
  AND blob11 = 'durable'
  AND double1 = 0
  AND double9 >= ${w.sinceSec} AND double9 <= ${w.untilSec}
  AND timestamp >= toDateTime(${w.sinceSec - INGEST_SLACK_SEC})
GROUP BY workflow_id, ordinal
ORDER BY ordinal
FORMAT JSON`
}
