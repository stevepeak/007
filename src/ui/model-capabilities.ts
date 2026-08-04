import type { ModelCapabilities, ModelOption } from '../engine/config'

// Shared capability-gating helpers for the model pickers (the agent/node Model
// field via `ModelSelect`, and the copilot dock's picker). One source of truth
// for "which required capabilities a model is missing" and the short reason we
// show when it's gated out.

// Short "why this model is unavailable" reason per required capability.
export const REQUIREMENT_REASON: Record<keyof ModelCapabilities, string> = {
  tools: 'no tool calling',
  structuredOutput: 'no structured output',
  reasoning: 'no reasoning',
  vision: 'no vision',
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
    (k) => requirements[k] && !model.capabilities?.[k],
  )
}
