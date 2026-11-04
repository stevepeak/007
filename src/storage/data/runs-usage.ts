import { and, inArray, isNotNull, sql } from 'drizzle-orm'

import { tokenCostUsd, type ModelPriceMap } from '../../engine/cost'
import type { WfDb } from '../client'
import { wfRunStep } from '../schema'

import { selectChunked } from './shared'

// ---------------------------------------------------------------------------
// Agent token usage, summed in SQL
// ---------------------------------------------------------------------------
//
// A step records its agent's model and token usage in columns the recorder copies
// out of `meta`, and the dollars it was priced at in `cost_usd_at_run`. A step
// with no recorded dollars is priced by multiplying its tokens against today's
// model catalog.
//
// The sum happens in SQLite, which returns one small row per (run, model) instead
// of one fat row per step: `meta` is where an agent step keeps its ENTIRE
// transcript, so folding it in JS reads megabytes to display two numbers per row.
// PRICING stays in JS: `tokenCostUsd` remains the only place tokens become
// dollars, and the price map keeps its own precedence rules, so there is no
// second cost implementation to drift from the first.

/** Tokens are stamped on model calls alone, so this is what makes a step one. */
export const isModelCall = isNotNull(wfRunStep.inputTokens)

/**
 * Both sums assume {@link isModelCall}: a group holding only other steps would
 * sum to NULL rather than the `number` these claim.
 */
export const inputTokensExpr = sql<number>`sum(${wfRunStep.inputTokens})`
export const outputTokensExpr = sql<number>`sum(${wfRunStep.outputTokens})`

/**
 * Dollars priced at run time. Pair it with {@link hasRunPriceExpr} in the GROUP
 * BY: a group mixing stamped and unstamped steps would sum to a figure that
 * omits the unstamped steps' cost while still counting their tokens.
 */
export const costUsdAtRunExpr = sql<number | null>`sum(${wfRunStep.costUsdAtRun})`
export const hasRunPriceExpr = sql`${wfRunStep.costUsdAtRun} is not null`

/**
 * Summed agent-call wall clock, in MILLISECONDS.
 *
 * The `* 1000` is load-bearing and easy to lose: these columns are drizzle
 * `integer({ mode: 'timestamp' })`, which stores SECONDS. Reading them through
 * the query builder hands back a `Date`, so JS never sees the unit — but doing
 * arithmetic in SQL does, and subtracting them straight yields seconds. Without
 * the conversion every agent duration reads 1000× too fast, which looks
 * plausible rather than broken.
 *
 * Only CLOSED windows count — an open step contributes nothing rather than
 * being paired with `now`, which would make an in-flight agent look like it had
 * finished instantly. Null when no step in the group closed one, which is what
 * lets the caller fall back to the run's own wall clock.
 */
const agentMsExpr = sql<number | null>`sum(case
  when ${wfRunStep.startedAt} is not null
   and ${wfRunStep.finishedAt} is not null
   and ${wfRunStep.finishedAt} >= ${wfRunStep.startedAt}
  then (${wfRunStep.finishedAt} - ${wfRunStep.startedAt}) * 1000
end)`

/**
 * The agent version frozen into the run manifest and stamped on the step.
 * `min` rather than "first seen": a run's agent nodes all resolve from the same
 * frozen manifest, so any one of them is the answer — and an aggregate that
 * doesn't depend on row order is one fewer thing to be flaky about.
 */
const agentVersionExpr = sql<
  number | null
>`min(json_extract(${wfRunStep.meta}, '$.agentVersion'))`

/**
 * One run's usage of one model. A run that fired no agents produces no rows. A
 * model yields two rows when only some of its steps carry a run-time price.
 */
export type RunUsageRow = {
  runId: string
  model: string | null
  inputTokens: number
  outputTokens: number
  /** Dollars priced at run time; null prices these tokens at today's catalog. */
  costUsdAtRun: number | null
  /** Summed agent wall-clock for this (run, model); null when none closed. */
  agentMs: number | null
  /** The frozen agent version stamped on these steps; null when unstamped. */
  agentVersion: number | null
}

/**
 * Token usage per (run, model) for a set of runs, summed in SQL.
 *
 * Grouped by model rather than just by run because the price is per model: a
 * run that called a cheap model 30 times and an expensive one once cannot be
 * priced from a single token total. It also hands the caller the model UNION
 * for free, which is what a rolled-up parent needs to name every model its
 * children used.
 */
export async function selectRunUsage(
  db: WfDb,
  runIds: readonly string[],
): Promise<RunUsageRow[]> {
  if (runIds.length === 0) return []
  // Chunked, and grouped by the chunked column — so per-chunk results
  // concatenate without merging (see `selectChunked`'s correctness rule). The
  // other grouping keys ride along inside a run and never span one.
  return await selectChunked(runIds, (ids) => {
    return db
      .select({
        runId: wfRunStep.runId,
        model: wfRunStep.modelId,
        inputTokens: inputTokensExpr,
        outputTokens: outputTokensExpr,
        costUsdAtRun: costUsdAtRunExpr,
        agentMs: agentMsExpr,
        agentVersion: agentVersionExpr,
      })
      .from(wfRunStep)
      .where(and(inArray(wfRunStep.runId, ids), isModelCall))
      .groupBy(wfRunStep.runId, wfRunStep.modelId, hasRunPriceExpr)
  })
}

/** Tokens + dollars + the models involved, folded from usage rows. */
export type UsageTotals = {
  /** Null when nothing in the fold fired an agent. */
  totalTokens: number | null
  /** Null when no model involved carries a catalog price (partial pricing sums
   *  best-effort, so a priced model beside an unpriced one still yields a figure). */
  costUsd: number | null
  /** Every model that contributed, deduped. Unnamed models are dropped — they
   *  can't be priced or displayed, and their tokens are still counted above. */
  models: string[]
  /** Summed agent-call wall clock; null when no agent step closed a window. */
  agentMs: number | null
  /** The frozen agent version, or null when nothing folded in carried one. */
  agentVersion: number | null
}

/** Fold a set of {@link RunUsageRow} into one {@link UsageTotals}. */
export function foldUsage(
  rows: Iterable<RunUsageRow>,
  priceMap: ModelPriceMap,
): UsageTotals {
  let tokens = 0
  let hasTokens = false
  let cost = 0
  let hasCost = false
  const models = new Set<string>()
  let agentMs = 0
  let hasAgentMs = false
  let agentVersion: number | null = null
  for (const r of rows) {
    const input = Number(r.inputTokens ?? 0)
    const output = Number(r.outputTokens ?? 0)
    tokens += input + output
    hasTokens = true
    if (r.model != null) models.add(r.model)
    const price = r.model == null ? undefined : priceMap.get(r.model)
    const c = r.costUsdAtRun ?? tokenCostUsd(input, output, price)
    if (c != null) {
      cost += c
      hasCost = true
    }
    if (r.agentMs != null) {
      agentMs += Math.max(0, Number(r.agentMs))
      hasAgentMs = true
    }
    agentVersion ??= r.agentVersion
  }
  return {
    totalTokens: hasTokens ? tokens : null,
    costUsd: hasCost ? cost : null,
    models: [...models],
    agentMs: hasAgentMs ? agentMs : null,
    agentVersion,
  }
}

/** Group usage rows by run id, for callers folding per run. */
export function groupUsageByRun(
  rows: readonly RunUsageRow[],
): Map<string, RunUsageRow[]> {
  const out = new Map<string, RunUsageRow[]>()
  for (const r of rows) {
    const arr = out.get(r.runId) ?? []
    arr.push(r)
    out.set(r.runId, arr)
  }
  return out
}
