import { inArray } from 'drizzle-orm'

import type { WfDb } from '../client'
import {
  agentUsage,
  tokenCostUsd,
  type ModelPrice,
  type ModelPriceMap,
} from '../cost'
import { wfModel, wfRun, wfRunStep } from '../schema'

// ---------------------------------------------------------------------------
// Cost derivation — model price map + per-run token/cost/timing stats
// ---------------------------------------------------------------------------

/**
 * How long a loaded price map stays warm. `wf_model` only changes when an admin
 * refreshes a provider catalog or toggles a model, so a minute of staleness on a
 * *displayed dollar figure* is immaterial — while the read itself sits behind
 * every run-viewer tick, eval poll, and runs-list page.
 */
const PRICE_MAP_TTL_MS = 60_000

/**
 * Cache the SETTLED value, never the in-flight promise: workerd throws
 * "Cannot perform I/O on behalf of a different request" when a later request
 * awaits a promise created in an earlier request's I/O context. A concurrent
 * miss therefore just runs the query twice, which is cheap and rare.
 *
 * Keyed by the underlying driver (`$client` — the D1 binding in a Worker, the
 * sqlite handle under a test) rather than the drizzle wrapper, because
 * `createWfDb` mints a fresh wrapper per request and keying on that would never
 * hit. Keying on the driver also means two handles onto *different* databases
 * can never share an entry: a process that talks to several databases (the
 * `createWfDbHttp` CLI, a test file building its own in-memory DB) is correct
 * by construction instead of by convention.
 */
const priceMapCache = new WeakMap<object, { at: number; map: ModelPriceMap }>()

/** The driver behind a handle, or null when it can't be identified (in which
 *  case we simply don't cache). */
function priceMapKey(db: WfDb): object | null {
  const client = (db as unknown as { $client?: unknown }).$client
  return typeof client === 'object' && client !== null ? client : null
}

/**
 * Drop the memo after a catalog write, so an admin who refreshes models sees
 * new prices immediately instead of up to {@link PRICE_MAP_TTL_MS} later.
 * Clears THIS isolate only — others converge within the TTL.
 */
export function invalidateModelPriceMap(db: WfDb): void {
  const key = priceMapKey(db)
  if (key) priceMapCache.delete(key)
}

/**
 * Every catalogued model's price, keyed for cost derivation. A run step records
 * `meta.model` as the provider-native id (`wf_model.modelId`); we key by that AND
 * the composite `id` so either resolves. Shared by the runs list (aggregate) and
 * the run inspector (per node).
 *
 * The underlying read is a full `wf_model` scan — `refreshModels` upserts a
 * provider's entire catalog (300+ rows) and never prunes — so it is memoized for
 * {@link PRICE_MAP_TTL_MS}. The returned map is SHARED across requests and must
 * be treated read-only; every consumer only ever `.get()`s from it.
 */
export async function loadModelPriceMap(db: WfDb): Promise<ModelPriceMap> {
  const key = priceMapKey(db)
  const hit = key ? priceMapCache.get(key) : undefined
  if (hit && Date.now() - hit.at < PRICE_MAP_TTL_MS) return hit.map
  const rows = await db
    .select({
      id: wfModel.id,
      modelId: wfModel.modelId,
      costPerMTok: wfModel.costPerMTok,
      promptPricePerMTok: wfModel.promptPricePerMTok,
      completionPricePerMTok: wfModel.completionPricePerMTok,
    })
    .from(wfModel)
  const map: ModelPriceMap = new Map()
  for (const r of rows) {
    const price: ModelPrice = {
      promptPerMTok: r.promptPricePerMTok,
      completionPerMTok: r.completionPricePerMTok,
      blendedPerMTok: r.costPerMTok,
    }
    map.set(r.modelId, price)
    // Don't let a composite-id entry clobber a bare-id match (what steps record).
    if (!map.has(r.id)) map.set(r.id, price)
  }
  if (key) priceMapCache.set(key, { at: Date.now(), map })
  return map
}

/**
 * Per-run cost / speed / model, keyed by run id — powers the eval report's
 * per-sample stats and the run's rolled-up averages. Every figure is scoped to
 * the AGENT CALL(S) only: tokens/cost sum the agent steps' usage (tools, the
 * trigger, and outputs carry none), and `durationMs` is the agent steps' own
 * wall-clock — never the whole run, and never the judge/test grading (which
 * runs after the wf_run finishes and records no steps). `models` are the
 * provider-native ids of those agent steps.
 */
export type RunStats = {
  totalTokens: number | null
  costUsd: number | null
  models: string[]
  /** Agent-call duration in ms: sum of each agent step's own window. Falls back
   *  to the run wall-clock only when no agent step recorded timing; null when
   *  neither is available. */
  durationMs: number | null
}

/**
 * Load {@link RunStats} for a set of runs in one pass — the run rows (for a
 * timing fallback) plus their agent steps' token usage + windows (for tokens,
 * cost, models, and agent-call duration). Mirrors {@link attachRunCost}'s
 * aggregation. Runs with no id in `runIds` are absent from the returned map.
 */
export async function loadRunStats(
  db: WfDb,
  runIds: string[],
): Promise<Map<string, RunStats>> {
  const out = new Map<string, RunStats>()
  if (runIds.length === 0) return out
  const [priceMap, runRows, stepRows] = await Promise.all([
    loadModelPriceMap(db),
    db
      .select({
        id: wfRun.id,
        startedAt: wfRun.startedAt,
        finishedAt: wfRun.finishedAt,
      })
      .from(wfRun)
      .where(inArray(wfRun.id, runIds)),
    db
      .select({
        runId: wfRunStep.runId,
        meta: wfRunStep.meta,
        startedAt: wfRunStep.startedAt,
        finishedAt: wfRunStep.finishedAt,
      })
      .from(wfRunStep)
      .where(inArray(wfRunStep.runId, runIds)),
  ])

  // Run wall-clock, used only as a duration fallback when agent steps carry no
  // timing of their own.
  const runWallMs = new Map<string, number | null>()
  for (const r of runRows) {
    const start = r.startedAt?.getTime() ?? null
    const end = r.finishedAt?.getTime() ?? null
    runWallMs.set(r.id, start != null && end != null ? end - start : null)
    out.set(r.id, {
      totalTokens: null,
      costUsd: null,
      models: [],
      durationMs: null,
    })
  }

  const agg = new Map<
    string,
    {
      tokens: number
      hasTokens: boolean
      cost: number
      hasCost: boolean
      models: Set<string>
      agentMs: number
      hasAgentMs: boolean
    }
  >()
  for (const sr of stepRows) {
    const usage = agentUsage(sr.meta)
    if (!usage) continue
    const a = agg.get(sr.runId) ?? {
      tokens: 0,
      hasTokens: false,
      cost: 0,
      hasCost: false,
      models: new Set<string>(),
      agentMs: 0,
      hasAgentMs: false,
    }
    a.tokens += usage.inputTokens + usage.outputTokens
    a.hasTokens = true
    a.models.add(usage.model)
    const cost = tokenCostUsd(
      usage.inputTokens,
      usage.outputTokens,
      priceMap.get(usage.model),
    )
    if (cost != null) {
      a.cost += cost
      a.hasCost = true
    }
    const start = sr.startedAt?.getTime()
    const end = sr.finishedAt?.getTime()
    if (start != null && end != null) {
      a.agentMs += Math.max(0, end - start)
      a.hasAgentMs = true
    }
    agg.set(sr.runId, a)
  }

  for (const [runId, a] of agg) {
    const base = out.get(runId) ?? {
      totalTokens: null,
      costUsd: null,
      models: [],
      durationMs: null,
    }
    base.totalTokens = a.hasTokens ? a.tokens : null
    base.costUsd = a.hasCost ? a.cost : null
    base.models = [...a.models]
    base.durationMs = a.hasAgentMs ? a.agentMs : (runWallMs.get(runId) ?? null)
    out.set(runId, base)
  }
  return out
}
