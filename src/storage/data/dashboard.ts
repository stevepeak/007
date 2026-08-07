import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm'

import {
  analyticsCoversWindow,
  loadRunVolume,
  loadSpend,
  loadWorkflowSteps,
  type AnalyticsCostRow,
  type AnalyticsStepsRow,
} from '../../analytics/dashboard'
import type { AnalyticsQuery } from '../../analytics/query'
import type { AnalyticsWindow } from '../../analytics/sql'
import type { WfDb } from '../client'
import { tokenCostUsd, type ModelPriceMap } from '../cost'
import {
  wfFeedback,
  wfRun,
  wfRunStep,
  wfWorkflow,
  wfWorkflowVersion,
} from '../schema'

import { loadModelPriceMap } from './runs-cost'
import { listRuns } from './runs-list'

// ---------------------------------------------------------------------------
// Home-dashboard rollup — run volume, spend, failures, feedback queue
// ---------------------------------------------------------------------------
//
// One load powering the home page's four panels. Everything is derived from
// tables that already exist; there is no dashboard table and no materialized
// aggregate.
//
// Two things shape every query here:
//
//  1. Time columns are `integer(mode:'timestamp')`, i.e. unix SECONDS, so a
//     bucket is just integer division: `created_at / 86400` is the UTC day
//     ordinal. Bucketing arithmetically (rather than via `strftime`) keeps the
//     key an integer end to end — no date-string parsing, no timezone ambiguity,
//     and the series index is `ordinal - firstOrdinal`.
//  2. `wf_run_step` carries no timestamp index and no `created_at` at all, so
//     the spend query filters through `wf_run.created_at` (covered by
//     `wf_run_eval_created_idx`) and reaches steps by `run_id` (the leading
//     column of `wf_run_step_run_sequence_idx`).
//
// Eval runs are excluded everywhere (`is_eval = false`), matching the Runs
// explorer and the workflows-list stats.

const HOUR_SEC = 3600
const DAY_SEC = 86_400

/** Widest window the dashboard will query. */
const MAX_WINDOW_MS = 90 * DAY_SEC * 1000
const DEFAULT_WINDOW_MS = 7 * DAY_SEC * 1000
/** Above this, an hourly bucket is coerced to daily (see {@link resolveWindow}). */
const MAX_BUCKETS = 400

/** How many named series a chart carries before the tail folds into "Other". */
const MAX_RUN_SERIES = 8
const MAX_COST_SERIES = 8

/** Failed runs listed in the errors panel. */
const RECENT_FAILURE_LIMIT = 10

export type DashboardBucket = 'hour' | 'day'

export type DashboardInput = {
  /** Window start, epoch ms. Defaults to 7 days before `until`. */
  since?: number
  /** Window end, epoch ms. Defaults to `now`. */
  until?: number
  bucket?: DashboardBucket
}

/** The window actually queried, after clamping. */
export type DashboardWindow = {
  since: number
  until: number
  bucket: DashboardBucket
  /** Bucket start times, epoch ms — the shared x-axis for every series. */
  buckets: number[]
  /** Ordinal (`seconds / bucketSize`) of `buckets[0]`. */
  firstOrdinal: number
}

/** One named line/stack in a chart, index-aligned with {@link DashboardWindow.buckets}. */
export type DashboardSeries = {
  /** Stable identity (workflow id, model id); `''` for the synthetic "Other". */
  key: string
  label: string
  /** Sum across the window — what the series is ranked and folded by. */
  total: number
  points: number[]
}

/**
 * Which backend answered a panel. Analytics Engine figures are SAMPLED
 * estimates with ~a minute of ingest lag; D1 figures are exact. The UI says so,
 * because a silent switch between them would look like the numbers moved.
 */
export type DashboardSource = 'analytics' | 'db'

export type DashboardStats<TFailure> = DashboardWindow & {
  runs: {
    total: number
    failed: number
    /** Queued + running right now — deliberately NOT window-scoped. */
    inFlight: number
    /** Per-workflow run counts. */
    series: DashboardSeries[]
    /** Failed runs per bucket, across all workflows. */
    failedPoints: number[]
    source: DashboardSource
  }
  cost: {
    /**
     * Window spend across PRICED models, or null when nothing in the window
     * could be priced. Derived from token usage × the model's CURRENT catalog
     * price, so historical spend is re-priced whenever the catalog moves.
     */
    totalUsd: number | null
    totalTokens: number
    /** Tokens on models with no catalog price — counted, but not in `totalUsd`. */
    unpricedTokens: number
    /** Per-model spend in USD. */
    series: DashboardSeries[]
    source: DashboardSource
    /**
     * True when the dollars were priced AT EXECUTION TIME (the analytics path),
     * so they don't move when the catalog does. The D1 path re-prices against
     * the current catalog on every read; the UI footnotes which one it showed.
     */
    pricedAtRunTime: boolean
  }
  feedback: {
    /** Outstanding triage queue depth (all time, not window-scoped). */
    unacknowledged: number
    /** …of which are thumbs-down. */
    unacknowledgedDown: number
    /** Thumbs left within the window. */
    up: number
    down: number
    upPoints: number[]
    downPoints: number[]
  }
  /**
   * Cloudflare Workflows step consumption — the billing line a graph's node
   * count does not predict (three steps per node, one per iteration ITEM, two
   * per durable callee, plus the run envelope).
   *
   * Null, never zero, when analytics is unconfigured: D1 records no step counts,
   * so there is nothing to fall back to and a fabricated 0 would read as "this
   * run was free".
   */
  steps: {
    /** Billable `step.*` calls across the window. */
    total: number
    /** Durable runs those steps came from — inline runs bill none. */
    runs: number
    nodes: number
    iterationItems: number
    /** Steps per bucket. */
    points: number[]
    /** Steps per workflow — which graphs are step-expensive. */
    series: DashboardSeries[]
  } | null
  recentFailures: TFailure[]
}

// ---------------------------------------------------------------------------
// Pure shaping — unit-tested; the SQL above is verified against a live D1.
// ---------------------------------------------------------------------------

function bucketSeconds (bucket: DashboardBucket) {
  return bucket === 'hour' ? HOUR_SEC : DAY_SEC
}

/**
 * Clamp a caller's window and lay out its buckets. `now` is passed in rather
 * than read so this stays pure.
 *
 * An hourly bucket over a long window would emit thousands of points, so past
 * {@link MAX_BUCKETS} it degrades to daily rather than returning a chart no one
 * can read. Buckets align to UTC boundaries, and the first/last are inclusive —
 * a partial bucket at either end still gets a point.
 */
export function resolveWindow(
  input: DashboardInput,
  now: number,
): DashboardWindow {
  const until = Math.min(input.until ?? now, now)
  const requestedSince = input.since ?? until - DEFAULT_WINDOW_MS
  // Floor at `until - MAX_WINDOW_MS`, and never let an inverted range through.
  const since = Math.min(Math.max(requestedSince, until - MAX_WINDOW_MS), until)

  let bucket: DashboardBucket = input.bucket ?? 'day'
  let size = bucketSeconds(bucket)
  const firstOf = (b: number) => Math.floor(since / 1000 / b)
  const lastOf = (b: number) => Math.floor(until / 1000 / b)
  if (lastOf(size) - firstOf(size) + 1 > MAX_BUCKETS) {
    bucket = 'day'
    size = DAY_SEC
  }

  const firstOrdinal = firstOf(size)
  const lastOrdinal = lastOf(size)
  const buckets: number[] = []
  for (let o = firstOrdinal; o <= lastOrdinal; o++) buckets.push(o * size * 1000)
  return { since, until, bucket, buckets, firstOrdinal }
}

/** A zero-filled points array — the baseline every series accumulates into. */
const zeros = (n: number) => new Array<number>(n).fill(0)

/**
 * Accumulate `(key, ordinal, value)` triples into gap-free series.
 *
 * The gap-filling is the point: a bucket with no rows must still emit an
 * explicit `0`, otherwise a line chart interpolates straight across the quiet
 * days and reads as steady traffic. Ordinals outside the window are dropped
 * (the SQL bounds already exclude them; this guards a partial-bucket edge).
 */
function accumulate<R>(
  rows: R[],
  window: Pick<DashboardWindow, 'buckets' | 'firstOrdinal'>,
  read: (row: R) => { key: string; label: string; ordinal: number; value: number },
): DashboardSeries[] {
  const byKey = new Map<string, DashboardSeries>()
  for (const row of rows) {
    const { key, label, ordinal, value } = read(row)
    const i = ordinal - window.firstOrdinal
    if (i < 0 || i >= window.buckets.length) continue
    let series = byKey.get(key)
    if (!series) {
      series = { key, label, total: 0, points: zeros(window.buckets.length) }
      byKey.set(key, series)
    }
    series.points[i] = (series.points[i] ?? 0) + value
    series.total += value
  }
  return [...byKey.values()]
}

/**
 * Rank series by total and fold everything past `max` into one "Other" line.
 * Unbounded series would exhaust the categorical palette and turn the chart into
 * spaghetti; "Other" keeps the totals honest while capping the legend.
 */
export function collapseSeries(
  series: DashboardSeries[],
  max: number,
  otherLabel = 'Other',
): DashboardSeries[] {
  const ranked = [...series].sort((a, b) => b.total - a.total)
  if (ranked.length <= max) return ranked
  const head = ranked.slice(0, max)
  const tail = ranked.slice(max)
  const points = zeros(head[0]?.points.length ?? 0)
  let total = 0
  for (const s of tail) {
    for (const [i, v] of s.points.entries()) {
      points[i] = (points[i] ?? 0) + v
    }
    total += s.total
  }
  return [...head, { key: '', label: otherLabel, total, points }]
}

type RunVolumeRow = {
  workflowId: string
  workflowName: string
  ordinal: number
  runs: number
  failed: number
}

/** Shape the run-volume group-by into per-workflow series + failure totals. */
export function foldRunVolume(
  rows: RunVolumeRow[],
  window: DashboardWindow,
  source: DashboardSource = 'db',
): Omit<DashboardStats<never>['runs'], 'inFlight'> {
  const series = collapseSeries(
    accumulate(rows, window, (r) => ({
      key: r.workflowId,
      label: r.workflowName,
      ordinal: r.ordinal,
      value: Number(r.runs),
    })),
    MAX_RUN_SERIES,
  )
  const failedPoints = zeros(window.buckets.length)
  let total = 0
  let failed = 0
  for (const r of rows) {
    total += Number(r.runs)
    failed += Number(r.failed)
    const i = r.ordinal - window.firstOrdinal
    if (i >= 0 && i < failedPoints.length) {
      failedPoints[i] = (failedPoints[i] ?? 0) + Number(r.failed)
    }
  }
  return { total, failed, series, failedPoints, source }
}

type CostRow = {
  ordinal: number
  model: string | null
  inputTokens: number
  outputTokens: number
}

/**
 * Price the per-model token group-by into dollar series.
 *
 * `tokenCostUsd` returns null for a model the catalog never priced, and this
 * keeps those tokens in `unpricedTokens` instead of folding them in as $0 —
 * under-reporting spend silently is worse than showing an explicit caveat.
 */
export function foldCostRows(
  rows: CostRow[],
  priceMap: ModelPriceMap,
  window: DashboardWindow,
): DashboardStats<never>['cost'] {
  let totalTokens = 0
  let unpricedTokens = 0
  let totalUsd = 0
  let priced = false

  const priceable: Array<{ ordinal: number; model: string; usd: number }> = []
  for (const r of rows) {
    const input = Number(r.inputTokens) || 0
    const output = Number(r.outputTokens) || 0
    totalTokens += input + output
    const model = r.model
    const usd = model ? tokenCostUsd(input, output, priceMap.get(model)) : null
    if (usd == null || !model) {
      unpricedTokens += input + output
      continue
    }
    priced = true
    totalUsd += usd
    priceable.push({ ordinal: r.ordinal, model, usd })
  }

  const series = collapseSeries(
    accumulate(priceable, window, (r) => ({
      key: r.model,
      label: r.model,
      ordinal: r.ordinal,
      value: r.usd,
    })),
    MAX_COST_SERIES,
  )
  return {
    totalUsd: priced ? totalUsd : null,
    totalTokens,
    unpricedTokens,
    series,
    source: 'db',
    // The D1 path multiplies stored tokens by the CURRENT catalog price, so
    // these dollars move whenever the catalog does.
    pricedAtRunTime: false,
  }
}

/**
 * Shape already-priced spend rows. The analytics counterpart to
 * {@link foldCostRows}: the dollars arrive priced at execution time, so nothing
 * here consults the catalog and historical spend cannot drift. `unpricedTokens`
 * is what the priced subtotal leaves behind, which is the same distinction the
 * D1 fold draws by asking the price map.
 */
export function foldPricedCostRows(
  rows: AnalyticsCostRow[],
  window: DashboardWindow,
): DashboardStats<never>['cost'] {
  let totalTokens = 0
  let pricedTokens = 0
  let totalUsd = 0
  let priced = false

  const priceable: Array<{ ordinal: number; model: string; usd: number }> = []
  for (const r of rows) {
    totalTokens += r.inputTokens + r.outputTokens
    pricedTokens += r.pricedTokens
    if (!r.model || r.pricedTokens <= 0) continue
    priced = true
    totalUsd += r.costUsd
    priceable.push({ ordinal: r.ordinal, model: r.model, usd: r.costUsd })
  }

  return {
    totalUsd: priced ? totalUsd : null,
    totalTokens,
    unpricedTokens: Math.max(0, totalTokens - pricedTokens),
    series: collapseSeries(
      accumulate(priceable, window, (r) => ({
        key: r.model,
        label: r.model,
        ordinal: r.ordinal,
        value: r.usd,
      })),
      MAX_COST_SERIES,
    ),
    source: 'analytics',
    pricedAtRunTime: true,
  }
}

/** Shape the Workflows step group-by into the billing panel's totals + series. */
export function foldSteps(
  rows: AnalyticsStepsRow[],
  names: Map<string, string>,
  window: DashboardWindow,
): NonNullable<DashboardStats<never>['steps']> {
  const points = zeros(window.buckets.length)
  let total = 0
  let runs = 0
  let nodes = 0
  let iterationItems = 0
  for (const r of rows) {
    total += r.workflowSteps
    runs += r.runs
    nodes += r.nodes
    iterationItems += r.iterationItems
    const i = r.ordinal - window.firstOrdinal
    if (i >= 0 && i < points.length) {
      points[i] = (points[i] ?? 0) + r.workflowSteps
    }
  }
  return {
    total,
    runs,
    nodes,
    iterationItems,
    points,
    series: collapseSeries(
      accumulate(rows, window, (r) => ({
        key: r.workflowId,
        label: names.get(r.workflowId) ?? r.workflowId,
        ordinal: r.ordinal,
        value: r.workflowSteps,
      })),
      MAX_RUN_SERIES,
    ),
  }
}

type FeedbackQueueRow = { rating: string; acknowledged: number; count: number }
type FeedbackTrendRow = { rating: string; ordinal: number; count: number }

/** Queue depth (all time) + the window's up/down trend. */
export function foldFeedback(
  queue: FeedbackQueueRow[],
  trend: FeedbackTrendRow[],
  window: DashboardWindow,
): DashboardStats<never>['feedback'] {
  let unacknowledged = 0
  let unacknowledgedDown = 0
  for (const r of queue) {
    if (Number(r.acknowledged) === 1) continue
    unacknowledged += Number(r.count)
    if (r.rating === 'down') unacknowledgedDown += Number(r.count)
  }

  const upPoints = zeros(window.buckets.length)
  const downPoints = zeros(window.buckets.length)
  let up = 0
  let down = 0
  for (const r of trend) {
    const count = Number(r.count)
    const points = r.rating === 'down' ? downPoints : upPoints
    if (r.rating === 'down') down += count
    else up += count
    const i = r.ordinal - window.firstOrdinal
    if (i >= 0 && i < points.length) points[i] = (points[i] ?? 0) + count
  }
  return { unacknowledged, unacknowledgedDown, up, down, upPoints, downPoints }
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

type RecentFailure = Awaited<ReturnType<typeof listRuns>>['rows'][number]

/** What the handler hands in when the host has wired Analytics Engine reads. */
export type DashboardAnalytics = { query: AnalyticsQuery; dataset: string }

/**
 * Run one analytics panel, degrading to its D1 answer on ANY failure.
 *
 * Per panel, not per page: an AE outage, a token that lost its scope, or a
 * dataset that has not seen its first write should cost one chart, not the whole
 * dashboard. The failure is logged rather than swallowed silently — the `source`
 * flag on the wire is what makes the degradation visible in the UI.
 */
async function orFallBack<T>(
  panel: string,
  attempt: () => Promise<T>,
  fallback: () => T | Promise<T>,
): Promise<T> {
  try {
    return await attempt()
  } catch (err) {
    console.warn(`[wf] dashboard ${panel} fell back to D1:`, err)
    return await fallback()
  }
}

/**
 * Everything the home dashboard renders, in one pass: run volume per workflow,
 * spend per model, the outstanding feedback queue, and the newest failures.
 *
 * Six reads, all issued together and all bounded by the resolved window. The
 * spend query is the expensive one — `json_extract` has to parse each agent
 * step's full `meta` blob (which embeds every turn's tool inputs/outputs) — so
 * the window is clamped server-side rather than trusted off the wire.
 */
export async function loadDashboard(
  db: WfDb,
  input: DashboardInput = {},
  now = Date.now(),
  analytics?: DashboardAnalytics | null,
): Promise<DashboardStats<RecentFailure>> {
  const window = resolveWindow(input, now)
  const since = new Date(window.since)
  const until = new Date(window.until)
  // Server-controlled constant (3600 or 86400), so inlining it raw keeps the
  // fragment param-free and safe to reuse verbatim in GROUP BY.
  const size = sql.raw(String(bucketSeconds(window.bucket)))
  const runBucket = sql<number>`cast(${wfRun.createdAt} / ${size} as integer)`
  const feedbackBucket = sql<number>`cast(${wfFeedback.createdAt} / ${size} as integer)`
  const inWindow = and(
    eq(wfRun.isEval, false),
    gte(wfRun.createdAt, since),
    lte(wfRun.createdAt, until),
  )

  // The two migrated panels are LAZY: when analytics answers them, these never
  // run at all — which is the entire point, since the spend query is the
  // expensive one. They stay here, unchanged, as the fallback.
  const d1RunVolume = () =>
    db
      .select({
        workflowId: wfWorkflowVersion.workflowId,
        workflowName: wfWorkflow.name,
        ordinal: runBucket,
        runs: sql<number>`count(*)`,
        failed: sql<number>`sum(case when ${wfRun.status} = 'failed' then 1 else 0 end)`,
      })
      .from(wfRun)
      .innerJoin(
        wfWorkflowVersion,
        eq(wfRun.workflowVersionId, wfWorkflowVersion.id),
      )
      .innerJoin(wfWorkflow, eq(wfWorkflowVersion.workflowId, wfWorkflow.id))
      .where(inWindow)
      .groupBy(wfWorkflowVersion.workflowId, wfWorkflow.name, runBucket)

  // Only agent steps carry usage; the filter through `wf_run` is what keeps
  // this off a full step-table scan. `json_extract` still has to parse each
  // step's whole `meta` blob, tool inputs and outputs included.
  const d1Spend = () =>
    db
      .select({
        ordinal: runBucket,
        model: sql<string | null>`json_extract(${wfRunStep.meta}, '$.model')`,
        inputTokens: sql<number>`sum(coalesce(json_extract(${wfRunStep.meta}, '$.totalUsage.inputTokens'), 0))`,
        outputTokens: sql<number>`sum(coalesce(json_extract(${wfRunStep.meta}, '$.totalUsage.outputTokens'), 0))`,
      })
      .from(wfRunStep)
      .innerJoin(wfRun, eq(wfRunStep.runId, wfRun.id))
      .where(and(eq(wfRunStep.nodeKind, 'agent'), inWindow))
      .groupBy(runBucket, sql`json_extract(${wfRunStep.meta}, '$.model')`)

  const [inFlightRows, queueRows, trendRows] =
    await Promise.all([
      // In-flight is a "right now" reading, so it ignores the window.
      db
        .select({ count: sql<number>`count(*)` })
        .from(wfRun)
        .where(
          and(
            eq(wfRun.isEval, false),
            inArray(wfRun.status, ['queued', 'running']),
          ),
        ),

      // Triage queue depth — all outstanding items, not just this window's.
      db
        .select({
          rating: wfFeedback.rating,
          acknowledged: sql<number>`case when ${wfFeedback.ackAt} is null then 0 else 1 end`,
          count: sql<number>`count(*)`,
        })
        .from(wfFeedback)
        .groupBy(
          wfFeedback.rating,
          sql`case when ${wfFeedback.ackAt} is null then 0 else 1 end`,
        ),

      db
        .select({
          rating: wfFeedback.rating,
          ordinal: feedbackBucket,
          count: sql<number>`count(*)`,
        })
        .from(wfFeedback)
        .where(
          and(
            gte(wfFeedback.createdAt, since),
            lte(wfFeedback.createdAt, until),
          ),
        )
        .groupBy(wfFeedback.rating, feedbackBucket),
    ])

  // The errors panel reuses the runs list wholesale — it already resolves the
  // workflow name, error text, timing and per-run cost. It loads the price map
  // again internally; that is a memo hit (see `loadModelPriceMap`), not a second
  // `wf_model` scan, so it is not worth threading the map through `listRuns`.
  const failures = await listRuns(db, {
    status: 'failed',
    since,
    until,
    limit: RECENT_FAILURE_LIMIT,
  })

  // The analytics window, in the seconds AE speaks. Only used when a host wired
  // a query AND the window is inside AE's retention.
  const aeWindow: AnalyticsWindow = {
    sinceSec: Math.floor(window.since / 1000),
    untilSec: Math.ceil(window.until / 1000),
    size: bucketSeconds(window.bucket),
  }
  const useAnalytics =
    !!analytics && analyticsCoversWindow(aeWindow, Math.floor(now / 1000))

  const [runs, cost, steps] = await Promise.all([
    useAnalytics
      ? orFallBack(
          'run volume',
          async () => {
            const rows = await loadRunVolume(
              analytics.query,
              analytics.dataset,
              aeWindow,
            )
            // AE holds the workflow ID, never its name — names are editable and
            // a three-month-old point would show a stale one. Resolve live.
            const names = await workflowNames(
              db,
              rows.map((r) => r.workflowId),
            )
            return foldRunVolume(
              rows.map((r) => ({
                ...r,
                workflowName: names.get(r.workflowId) ?? r.workflowId,
              })),
              window,
              'analytics',
            )
          },
          async () => foldRunVolume(await d1RunVolume(), window),
        )
      : foldRunVolume(await d1RunVolume(), window),

    useAnalytics
      ? orFallBack(
          'spend',
          async () =>
            foldPricedCostRows(
              await loadSpend(analytics.query, analytics.dataset, aeWindow),
              window,
            ),
          async () =>
            foldCostRows(await d1Spend(), await loadModelPriceMap(db), window),
        )
      : foldCostRows(await d1Spend(), await loadModelPriceMap(db), window),

    // No D1 fallback exists — nothing in SQL counts `step.do` calls — so this
    // panel is null rather than zero whenever analytics can't answer.
    useAnalytics
      ? orFallBack(
          'workflow steps',
          async () => {
            const rows = await loadWorkflowSteps(
              analytics.query,
              analytics.dataset,
              aeWindow,
            )
            const names = await workflowNames(
              db,
              rows.map((r) => r.workflowId),
            )
            return foldSteps(rows, names, window)
          },
          () => null,
        )
      : null,
  ])

  return {
    ...window,
    runs: { ...runs, inFlight: Number(inFlightRows[0]?.count ?? 0) },
    cost,
    feedback: foldFeedback(queueRows, trendRows, window),
    steps,
    recentFailures: failures.rows,
  }
}

/** Resolve workflow ids to their CURRENT names — one small indexed read. */
async function workflowNames(
  db: WfDb,
  ids: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return new Map()
  const rows = await db
    .select({ id: wfWorkflow.id, name: wfWorkflow.name })
    .from(wfWorkflow)
    .where(inArray(wfWorkflow.id, unique))
  return new Map(rows.map((r) => [r.id, r.name]))
}
