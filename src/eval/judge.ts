import type { DecisionModelOption } from '../engine/decision'

/**
 * The decision judge a launch takes when none is named: the first calibrated
 * decider, else the first one. A threshold is a line drawn on the judge's
 * probabilities, so a judge whose probabilities mean something is the better
 * default. The run page pre-selects it and `run_eval` falls back to it, so
 * both default alike.
 */
export function defaultDecisionJudge(
  models: DecisionModelOption[],
): DecisionModelOption | undefined {
  return models.find((m) => m.calibrated !== false) ?? models[0]
}
