import type { AgentNodeMeta } from '../engine/nodes/agent'

// Per-node cost lives nowhere in the schema — a run step only records token
// usage (inside its AgentNodeMeta) and the model id. Dollar cost is DERIVED on
// read by multiplying that usage against the model's catalog price (wf_model).
// These pure helpers hold that math so the runs list (aggregate per run) and the
// run inspector (per node) compute cost the same way.

/**
 * Prices for one model, USD per 1M tokens. All optional — a model the catalog
 * never priced yields no cost (so callers show "—", not a misleading $0).
 */
export type ModelPrice = {
  promptPerMTok?: number | null
  completionPerMTok?: number | null
  /** Blended fallback used when the prompt/completion split isn't reported. */
  blendedPerMTok?: number | null
}

/** Prices keyed by model id (both the provider-native and composite forms). */
export type ModelPriceMap = Map<string, ModelPrice>

/**
 * USD cost of one agent step's token usage, or null when the model has no price
 * in the catalog. Prefers the prompt/completion split; falls back to the blended
 * per-Mtok rate.
 */
export function tokenCostUsd(
  inputTokens: number,
  outputTokens: number,
  price: ModelPrice | undefined,
): number | null {
  if (!price) return null
  const { promptPerMTok, completionPerMTok, blendedPerMTok } = price
  if (promptPerMTok != null || completionPerMTok != null) {
    return (
      (inputTokens * (promptPerMTok ?? 0) +
        outputTokens * (completionPerMTok ?? 0)) /
      1_000_000
    )
  }
  if (blendedPerMTok != null) {
    return ((inputTokens + outputTokens) * blendedPerMTok) / 1_000_000
  }
  return null
}

/**
 * Narrow an untyped step `meta` to its agent token usage, or null for non-agent
 * steps (branches, tools, iteration — no LLM tokens). Mirrors the `asAgentMeta`
 * narrowing the run inspector uses on the client.
 */
export function agentUsage(
  meta: unknown,
): { model: string; inputTokens: number; outputTokens: number } | null {
  if (
    meta &&
    typeof meta === 'object' &&
    Array.isArray((meta as { steps?: unknown }).steps) &&
    'totalUsage' in meta
  ) {
    const m = meta as AgentNodeMeta
    return {
      model: m.model,
      inputTokens: m.totalUsage?.inputTokens ?? 0,
      outputTokens: m.totalUsage?.outputTokens ?? 0,
    }
  }
  return null
}
