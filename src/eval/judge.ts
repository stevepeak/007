import type { ModelCapabilities } from '../engine/config'
import { unmetRequirements } from '../engine/model-capabilities'
import type { ModelOption } from '../engine/model-catalog'

/**
 * What a model needs to be an `llm_judge`: it grades by emitting a JSON verdict
 * (`generateObject` in ./grade), so it must do structured output.
 */
export const JUDGE_REQUIREMENTS: ModelCapabilities = { structuredOutput: true }

/** Blended USD per 1M tokens; unpriced models sort last. */
function price(model: ModelOption): number {
  if (model.costPerMTok != null) return model.costPerMTok
  if (model.promptPricePerMTok != null && model.completionPricePerMTok != null) {
    return model.promptPricePerMTok + model.completionPricePerMTok
  }
  return Infinity
}

/**
 * The judge a launch takes when none is named: the cheapest enabled model that
 * can judge. Ties — and a catalog with no prices — keep catalog order. The run
 * dialog pre-selects it and `run_eval` falls back to it, so both default alike.
 */
export function defaultJudgeModel(
  models: ModelOption[],
): ModelOption | undefined {
  return models
    .filter((m) => unmetRequirements(m, JUDGE_REQUIREMENTS).length === 0)
    .reduce<ModelOption | undefined>((best, m) => {
      return !best || price(m) < price(best) ? m : best
    }, undefined)
}
