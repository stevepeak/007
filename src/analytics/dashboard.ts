import { num, coerceStr, type AnalyticsQuery } from './query'
import {
  runVolumeSql,
  spendSql,
  workflowStepsSql,
  type AnalyticsWindow,
} from './sql'

// The Analytics-Engine-backed half of the dashboard load. Each function returns
// rows in the SAME shape the existing D1 folds already consume, so both sources
// converge on one set of pure, already-tested shaping functions and the wire
// contract doesn't change with the backend.

/**
 * AE retains roughly three months, while the dashboard's own ceiling is exactly
 * 90 days — so the far edge of the widest window would thin out and quietly
 * under-report. Past this, the caller falls back to D1 rather than serving a
 * tail that decays.
 */
export const ANALYTICS_MAX_WINDOW_SEC = 80 * 86_400

/** Whether AE can honestly answer for this window. */
export function analyticsCoversWindow(
  window: AnalyticsWindow,
  nowSec: number,
): boolean {
  return nowSec - window.sinceSec <= ANALYTICS_MAX_WINDOW_SEC
}

/** Per-workflow run volume. `workflowName` is resolved by the caller from D1. */
export type AnalyticsVolumeRow = {
  workflowId: string
  ordinal: number
  runs: number
  failed: number
}

export async function loadRunVolume(
  query: AnalyticsQuery,
  dataset: string,
  window: AnalyticsWindow,
): Promise<AnalyticsVolumeRow[]> {
  const rows = await query.run(runVolumeSql(dataset, window))
  return rows.map((r) => ({
    workflowId: coerceStr(r.workflow_id),
    ordinal: num(r.ordinal),
    runs: num(r.runs),
    failed: num(r.failed),
  }))
}

/**
 * Per-model spend. Unlike the D1 row this carries the dollars themselves —
 * priced when the tokens were spent — so the fold prices nothing and historical
 * spend stops moving when the catalog does.
 */
export type AnalyticsCostRow = {
  ordinal: number
  model: string | null
  inputTokens: number
  outputTokens: number
  costUsd: number
  /** Tokens on models that HAD a catalog price; the rest are unpriced. */
  pricedTokens: number
}

export async function loadSpend(
  query: AnalyticsQuery,
  dataset: string,
  window: AnalyticsWindow,
): Promise<AnalyticsCostRow[]> {
  const rows = await query.run(spendSql(dataset, window))
  return rows.map((r) => ({
    ordinal: num(r.ordinal),
    model: coerceStr(r.model) || null,
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    costUsd: num(r.cost_usd),
    pricedTokens: num(r.priced_tokens),
  }))
}

/** Per-workflow Cloudflare Workflows step consumption. No D1 equivalent. */
export type AnalyticsStepsRow = {
  workflowId: string
  ordinal: number
  runs: number
  workflowSteps: number
  nodes: number
  iterationItems: number
}

export async function loadWorkflowSteps(
  query: AnalyticsQuery,
  dataset: string,
  window: AnalyticsWindow,
): Promise<AnalyticsStepsRow[]> {
  const rows = await query.run(workflowStepsSql(dataset, window))
  return rows.map((r) => ({
    workflowId: coerceStr(r.workflow_id),
    ordinal: num(r.ordinal),
    runs: num(r.runs),
    workflowSteps: num(r.workflow_steps),
    nodes: num(r.nodes),
    iterationItems: num(r.iteration_items),
  }))
}
