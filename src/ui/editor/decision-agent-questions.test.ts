import { describe, expect, test } from 'bun:test'

import { isDerivedKey, keyFromLabel } from './decision-agent-questions'

describe('isDerivedKey', () => {
  test('a key minted for a blank choice is still derived, suffix and all', () => {
    const taken = new Set(['option'])
    const key = keyFromLabel('', taken)
    expect(key).toBe('option_2')
    expect(isDerivedKey(key, '')).toBe(true)
  })

  test('a de-duplicated key follows its label', () => {
    expect(isDerivedKey('billing', 'Billing')).toBe(true)
    expect(isDerivedKey('billing_3', 'Billing')).toBe(true)
  })

  test('a key that no longer matches its label is the author’s, not derived', () => {
    expect(isDerivedKey('billing', 'Payments')).toBe(false)
    expect(isDerivedKey('billing_extra', 'Billing')).toBe(false)
    expect(isDerivedKey('billing_', 'Billing')).toBe(false)
  })
})
