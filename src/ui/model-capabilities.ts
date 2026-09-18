import type { ModelCapabilities, ModelOption } from '../engine/config'

// Shared capability-gating helpers for the model pickers (the agent/node Model
// field via `ModelSelect`, and the eval "Run tests" model matrix). One source
// of truth for "which required capabilities a model is missing" and the short
// reason we show when a model is gated out. What an agent NEEDS is
// `agentModelRequirements` in the engine, next to the config it reads.

// Short "why this model is unavailable" reason per required capability.
export const REQUIREMENT_REASON: Record<keyof ModelCapabilities, string> = {
  tools: 'no tool calling',
  structuredOutput: 'no structured output',
  reasoning: 'no reasoning',
  vision: 'no vision',
  webSearch: 'no web search',
}

/**
 * The union of several agents' requirements — an eval run that spans more than
 * one target agent must pick a model every one of them can run on.
 */
export function mergeModelRequirements(
  requirements: ModelCapabilities[],
): ModelCapabilities {
  const merged: ModelCapabilities = {}
  for (const r of requirements) {
    for (const k of Object.keys(r) as (keyof ModelCapabilities)[]) {
      if (r[k] === true) merged[k] = true
    }
  }
  return merged
}

/**
 * Which required capabilities a model is missing. A model with NO capability
 * info at all (e.g. the pre-refresh static fallback list) is treated as unknown
 * and never gated — we only disable a model we KNOW lacks a requirement.
 */
export function unmetRequirements(
  model: ModelOption,
  requirements: ModelCapabilities | undefined,
): (keyof ModelCapabilities)[] {
  if (!requirements || !model.capabilities) return []
  return (Object.keys(requirements) as (keyof ModelCapabilities)[]).filter(
    (k) => requirements[k] === true && model.capabilities?.[k] !== true,
  )
}

/** The gate reason for a model, or undefined when it meets every requirement. */
export function unmetRequirementsReason(
  model: ModelOption,
  requirements: ModelCapabilities | undefined,
): string | undefined {
  const unmet = unmetRequirements(model, requirements)
  return unmet.length > 0
    ? unmet.map((k) => REQUIREMENT_REASON[k]).join(', ')
    : undefined
}
