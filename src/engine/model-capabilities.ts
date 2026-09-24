import type { ModelCapabilities, ModelOption } from './config'

// Capability gating: which of the capabilities an agent NEEDS
// (`agentModelRequirements`, next door) a given model is known to lack. One
// source of truth for that decision and for the short reason shown when a model
// is gated out.
//
// It lives in the engine rather than beside the pickers that first needed it
// because the pickers are no longer the only gate. `create_agent` (mcp/) refuses
// a config whose model cannot run it — an agent authored through a tool call has
// no disabled dropdown row to warn it — and nothing on that path may import
// `src/ui` (see the entry-point closure test in `package-exports.test.ts`).

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
