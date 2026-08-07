import type { WfRunSummary } from './protocol-runs'

// The home dashboard's single payload. Derived entirely from existing tables on
// each request — there is no dashboard table and nothing is precomputed. Eval
// runs are excluded throughout, matching the runs explorer.

export type WfDashboardBucket = 'hour' | 'day'

/** `since`/`until` are epoch millis over `wf_run.createdAt`, as in WfRunListInput. */
export type WfDashboardInput = {
  since?: number
  until?: number
  bucket?: WfDashboardBucket
}

/**
 * One named line/stack, index-aligned with {@link WfDashboardResult.buckets}.
 * `key` is the stable identity (workflow id, model id) and is `''` for the
 * synthetic "Other" series the tail folds into.
 */
export type WfDashboardSeries = {
  key: string
  label: string
  /** Sum across the window — what the series is ranked by. */
  total: number
  points: number[]
}

/**
 * Which backend answered a panel. `analytics` figures come from Cloudflare
 * Analytics Engine: sampled estimates with ~a minute of ingest lag, and priced
 * when the tokens were spent. `db` figures are exact and re-priced on read.
 */
export type WfDashboardSource = 'analytics' | 'db'

export type WfDashboardResult = {
  /** The window actually queried; the server clamps what the client asks for. */
  since: number
  until: number
  bucket: WfDashboardBucket
  /** Bucket start times, epoch ms — the shared x-axis for every series. */
  buckets: number[]

  runs: {
    total: number
    failed: number
    /** Queued + running right now; deliberately not window-scoped. */
    inFlight: number
    /** Run count per workflow. */
    series: WfDashboardSeries[]
    /** Failed runs per bucket across all workflows. */
    failedPoints: number[]
    source: WfDashboardSource
  }

  cost: {
    /**
     * Window spend across PRICED models, or null when nothing could be priced.
     * Token usage is multiplied by the model's CURRENT catalog price, so
     * historical spend is re-priced whenever the catalog moves.
     */
    totalUsd: number | null
    totalTokens: number
    /** Tokens on models with no catalog price — excluded from `totalUsd`. */
    unpricedTokens: number
    /** USD per model. */
    series: WfDashboardSeries[]
    source: WfDashboardSource
    /**
     * True when the dollars were priced AT EXECUTION TIME and therefore don't
     * move when the model catalog does. False on the D1 path, which re-prices
     * historical usage against today's catalog on every read.
     */
    pricedAtRunTime: boolean
  }

  feedback: {
    /** Outstanding triage queue depth, all time. */
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
   * count doesn't predict: three steps per node, one per iteration ITEM, two per
   * durable callee, plus the run envelope.
   *
   * Null (never zero) when analytics is unconfigured — nothing in SQL counts
   * `step.do` calls, so there is no fallback and a fabricated 0 would read as
   * "these runs were free".
   */
  steps: {
    /** Billable step calls across the window. */
    total: number
    /** Durable runs they came from; inline runs bill no steps. */
    runs: number
    nodes: number
    iterationItems: number
    /** Steps per bucket. */
    points: number[]
    /** Steps per workflow — which graphs are step-expensive. */
    series: WfDashboardSeries[]
  } | null

  /** Newest failed runs in the window, for the errors panel. */
  recentFailures: WfRunSummary[]
}
