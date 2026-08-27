import { and, inArray, sql, type SQL } from 'drizzle-orm'

import { stepAgentVersion } from '../../engine/nodes/agent-generation'
import type { WfDb } from '../client'
import { asAgentMeta, tokenCostUsd, type ModelPriceMap } from '../cost'
import { wfRunStep } from '../schema'

import { selectChunked } from './shared'

// ---------------------------------------------------------------------------
// Agent token usage, summed in SQL
// ---------------------------------------------------------------------------
//
// Cost is derived, not stored: a step records its agent's token usage inside
// the untyped `meta` JSON, and dollars come from multiplying that against the
// model catalog. The obvious way to aggregate it is to select `meta` and fold
// in JS — which is what this replaces, because `meta` is where an agent step
// keeps its ENTIRE transcript.
//
// Measured on the local D1: an agent step's `meta` averages 6.5 KB and a tool
// step's 1.3 KB, so 690 steps across 28 runs is ~2 MB of JSON. A 50-row page of
// the runs explorer already reads megabytes to display two numbers per row, and
// a recursive roll-up over a 12-item fan-out multiplies that by the fan-out
// factor. It does not survive.
//
// So the extraction moves into SQLite, which returns one small row per (run,
// model) instead of one fat row per step — the same ~2 MB collapses to a few
// hundred bytes. PRICING stays in JS: `tokenCostUsd` remains the only place
// tokens become dollars, and the price map keeps its own precedence rules, so
// there is no second cost implementation to drift from the first.

/**
 * The JSON paths below mirror {@link asAgentMeta} / `agentUsage` exactly, and
 * `runs-usage.test.ts` pins them to each other by running both over the same
 * rows. A step counts as an agent call when its meta has a `steps` ARRAY and a
 * `totalUsage` KEY — `json_type` returns `'null'` (not SQL NULL) for a key
 * present with a JSON null value, which is what makes it the faithful
 * translation of JS's `'totalUsage' in meta`.
 */
function agentStepCondition(): SQL {
  return sql`json_type(${wfRunStep.meta}, '$.steps') = 'array' and json_type(${wfRunStep.meta}, '$.totalUsage') is not null`
}

/** The provider-native model id the step recorded, or NULL if it recorded none. */
const modelExpr = sql<string | null>`json_extract(${wfRunStep.meta}, '$.model')`

/** `coalesce` to 0 mirrors `agentUsage`'s `?? 0` for a usage field never written. */
const inputTokensExpr = sql<number>`sum(coalesce(json_extract(${wfRunStep.meta}, '$.totalUsage.inputTokens'), 0))`
const outputTokensExpr = sql<number>`sum(coalesce(json_extract(${wfRunStep.meta}, '$.totalUsage.outputTokens'), 0))`

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
const agentVersionExpr = sql<number | null>`min(json_extract(${wfRunStep.meta}, '$.agentVersion'))`

/** One run's usage of one model. A run that fired no agents produces no rows. */
export type RunUsageRow = {
  runId: string
  model: string | null
  inputTokens: number
  outputTokens: number
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
  // second grouping key, `model`, rides along inside a run and never spans one.
  return await selectChunked(runIds, (ids) =>
    db
      .select({
        runId: wfRunStep.runId,
        model: modelExpr,
        inputTokens: inputTokensExpr,
        outputTokens: outputTokensExpr,
        agentMs: agentMsExpr,
        agentVersion: agentVersionExpr,
      })
      .from(wfRunStep)
      .where(and(inArray(wfRunStep.runId, ids), agentStepCondition()))
      .groupBy(wfRunStep.runId, modelExpr),
  )
}

/**
 * The JS half of the same read, for callers that already hold the step rows.
 * Exists so `runs-usage.test.ts` can assert the SQL predicate and this one
 * classify identical rows identically — the drift this module is most exposed
 * to is the SQL quietly disagreeing about what an agent step IS.
 */
export function usageRowFromMeta(
  runId: string,
  meta: unknown,
): RunUsageRow | null {
  const m = asAgentMeta(meta)
  if (!m) return null
  return {
    runId,
    model: m.model ?? null,
    inputTokens: m.totalUsage?.inputTokens ?? 0,
    outputTokens: m.totalUsage?.outputTokens ?? 0,
    agentMs: null,
    agentVersion: stepAgentVersion(meta),
  }
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
    const c = tokenCostUsd(input, output, price)
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
