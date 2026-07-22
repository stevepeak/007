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
 * Every catalogued model's price, keyed for cost derivation. A run step records
 * `meta.model` as the provider-native id (`wf_model.modelId`); we key by that AND
 * the composite `id` so either resolves. One small table scan, shared by the runs
 * list (aggregate) and the run inspector (per node).
 */
export async function loadModelPriceMap(db: WfDb): Promise<ModelPriceMap> {
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
