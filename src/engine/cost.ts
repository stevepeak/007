import type { AgentNodeMeta } from './nodes/agent'

// Per-node cost lives nowhere in the schema — a run step only records token
// usage (inside its AgentNodeMeta) and the model id. Dollar cost is DERIVED on
// read by multiplying that usage against the model's catalog price (wf_model).
// These pure helpers hold that math so the runs list (aggregate per run) and the
// run inspector (per node) compute cost the same way.
//
// It lives in `engine` — not `storage`, where it used to — because THREE layers
// price the same usage and two of them sit below the other: `analytics` prices a
// step as it happens (`analytics/points.ts`), `storage` prices it again on read,
// and `cloudflare` carries the price map into the dispatcher. With the math in
// storage, `analytics → storage → analytics` was a genuine import cycle. Nothing
// here touches a database: the price map is loaded by `storage/data/runs-cost.ts`
// and passed in.

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
 * A single run step's token count + dollar cost, derived from its recorded agent
 * usage and the model price map. Null when the step ran no agent (no usage);
 * `cost` is null when the step's model carries no catalog price. The one place
 * "usage → tokens + cost" lives, so the runs-list aggregate and the run
 * inspector's per-step total never drift.
 */
export function stepCost(
  meta: unknown,
  priceMap: ModelPriceMap,
): { tokens: number; cost: number | null } | null {
  const usage = agentUsage(meta)
  if (!usage) return null
  return {
    tokens: usage.inputTokens + usage.outputTokens,
    cost: tokenCostUsd(
      usage.inputTokens,
      usage.outputTokens,
      priceMap.get(usage.model),
    ),
  }
}

/**
 * Narrow an untyped step `meta` to an agent generation's meta, or null for a
 * non-agent step (branch, tool, iteration — no LLM turns). Mirrors the
 * `asAgentMeta` narrowing the run inspector uses on the client. The shape test
 * is structural on purpose: `meta` is `unknown` at the recorder seam and older
 * rows predate fields that were added since.
 */
export function asAgentMeta(meta: unknown): AgentNodeMeta | null {
  if (
    meta &&
    typeof meta === 'object' &&
    Array.isArray((meta as { steps?: unknown }).steps) &&
    'totalUsage' in meta
  ) {
    return meta as AgentNodeMeta
  }
  return null
}

/**
 * Narrow an untyped step `meta` to a DECISION agent's meta, or null.
 *
 * A second shape rather than a widened {@link asAgentMeta}, because the two
 * share no field: a decider makes one call and returns a distribution, so there
 * is no `steps` transcript and no `totalUsage` — it records `modelId` and
 * `usage`. `questionIds` is the discriminator: it is the one key only a decision
 * step writes, so nothing else can be mistaken for one.
 */
export function asDecisionMeta(
  meta: unknown,
): { modelId?: string; usage?: { inputTokens?: number; outputTokens?: number } } | null {
  if (
    meta &&
    typeof meta === 'object' &&
    Array.isArray((meta as { questionIds?: unknown }).questionIds) &&
    'usage' in meta
  ) {
    return meta as {
      modelId?: string
      usage?: { inputTokens?: number; outputTokens?: number }
    }
  }
  return null
}

/**
 * Narrow an untyped step `meta` to its token usage, or null for a step that
 * spent none (branches, tools, iteration).
 *
 * Reads BOTH agent shapes. A decision step was invisible here until it was
 * added, which meant a run whose only model call was a decision agent reported
 * `totalTokens: null` and no cost at all — the tokens were on the step the whole
 * time, under different key names.
 *
 * A decision step's `modelId` is the COMPOSITE catalog id while a generation
 * step's `model` is the provider-native one. That is fine: the price map is
 * keyed by both, precisely so either resolves.
 */
export function agentUsage(
  meta: unknown,
): { model: string; inputTokens: number; outputTokens: number } | null {
  const m = asAgentMeta(meta)
  if (m) {
    return {
      model: m.model,
      inputTokens: m.totalUsage?.inputTokens ?? 0,
      outputTokens: m.totalUsage?.outputTokens ?? 0,
    }
  }
  const d = asDecisionMeta(meta)
  if (d) {
    return {
      // An unreported model prices as nothing rather than throwing off the
      // lookup — same as a generation step that recorded no model.
      model: d.modelId ?? '',
      inputTokens: d.usage?.inputTokens ?? 0,
      outputTokens: d.usage?.outputTokens ?? 0,
    }
  }
  return null
}
