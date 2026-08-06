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

  /** Newest failed runs in the window, for the errors panel. */
  recentFailures: WfRunSummary[]
}
