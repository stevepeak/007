import { describe, expect, test } from 'bun:test'

import type { DecisionModelOption } from '../engine/decision'

import { defaultDecisionJudge } from './judge'

function decider(id: string, calibrated?: boolean): DecisionModelOption {
  return { id, label: id, providerId: 'p', calibrated }
}

describe('defaultDecisionJudge', () => {
  test('prefers the first calibrated decider', () => {
    const models = [decider('emulated', false), decider('native', true)]
    expect(defaultDecisionJudge(models)?.id).toBe('native')
  })

  test('falls back to the first decider when none is calibrated', () => {
    const models = [decider('a', false), decider('b', false)]
    expect(defaultDecisionJudge(models)?.id).toBe('a')
  })

  test('an empty catalog has no default', () => {
    expect(defaultDecisionJudge([])).toBeUndefined()
  })
})
