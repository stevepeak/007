import { describe, expect, test } from 'bun:test'

import type { ModelOption } from '../engine/config'

import { REQUIREMENT_REASON, unmetRequirements } from './model-capabilities'

// The agent editor's guarantee: a setting that needs a model capability can only
// be ON when the chosen model has it. The picker is the primary guard — it
// disables any model that can't meet what the agent is currently configured to
// need — and `unmetRequirements` is the whole of that decision, so it is worth
// pinning directly.
//
// `reasoning` is the newest requirement and the one with a live default (off),
// so these lean on it; the mechanism is shared with tools and structured output.

function model (id: string,
  capabilities?: ModelOption['capabilities']): ModelOption {
  return { id, label: id, ...(capabilities ? { capabilities } : {}) }
}

const CAN_REASON = model('thinker', { reasoning: true, tools: true })
const CANNOT_REASON = model('fast', { reasoning: false, tools: true })
/** The pre-refresh static list: no capability info at all. */
const UNKNOWN = model('legacy')

describe('unmetRequirements', () => {
  test('gates out a model that cannot meet a required capability', () => {
    expect(unmetRequirements(CANNOT_REASON, { reasoning: true })).toEqual([
      'reasoning',
    ])
  })

  test('a capable model meets the requirement', () => {
    expect(unmetRequirements(CAN_REASON, { reasoning: true })).toEqual([])
  })

  test('a requirement that is OFF gates nothing', () => {
    // The agent's reasoning setting defaults to false, so this is the common
    // case: with it off, every model stays selectable.
    expect(unmetRequirements(CANNOT_REASON, { reasoning: false })).toEqual([])
  })

  test('a model with unknown capabilities is never gated', () => {
    // Deliberate, and consistent across every capability: disabling working
    // models on missing metadata is worse than allowing one that may not fit.
    expect(unmetRequirements(UNKNOWN, { reasoning: true })).toEqual([])
  })

  test('reports every unmet requirement, not just the first', () => {
    const noneOfIt = model('plain', {
      reasoning: false,
      tools: false,
      structuredOutput: false,
    })
    expect(
      unmetRequirements(noneOfIt, {
        reasoning: true,
        tools: true,
        structuredOutput: true,
      }).sort(),
    ).toEqual(['reasoning', 'structuredOutput', 'tools'])
  })

  test('every capability has a reason string to show when it gates a model', () => {
    // A gated-out model must always be able to say why. A capability added to
    // `ModelCapabilities` without a reason here would render a blank
    // explanation, so this asserts the two stay in step.
    for (const key of ['tools', 'reasoning', 'structuredOutput', 'vision'] as const) {
      expect(REQUIREMENT_REASON[key]).toBeTruthy()
    }
  })
})
