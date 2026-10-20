import { describe, expect, test } from 'bun:test'

import { isDerivedKey, keyFromLabel, moved } from './decision-agent-questions'

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

// A choice key is saved in the agent config and matched against the
// provider's answer, so the key a label mints is frozen. No accent folding;
// the cut at 40 keeps a trailing `_` if it lands on one.
describe('keyFromLabel', () => {
  test('pinned output', () => {
    const pinned: [string, string][] = [
      ['Café', 'caf'],
      ['Crème Brûlée!', 'cr_me_br_l_e'],
      ['🚀 Launch 🚀', 'launch'],
      ['🚀', 'option'],
      ['Hello, World!', 'hello_world'],
      ['--leading and trailing--', 'leading_and_trailing'],
      ['__under__', 'under'],
      ['', 'option'],
      ['   ', 'option'],
      ['123 go', '123_go'],
      ['2fast', '2fast'],
      ['ÀÉÎÕÜ', 'option'],
      ['ﬁle ²', 'le'],
      ['İstanbul', 'i_stanbul'],
      ['Straße', 'stra_e'],
      ['MiXeD_Case-Name', 'mixed_case_name'],
      ['tab\tnew\nline', 'tab_new_line'],
      ['a'.repeat(39) + ' b', 'a'.repeat(39) + '_'],
      ['x'.repeat(62) + '-yz', 'x'.repeat(40)],
      ['word '.repeat(20), 'word_'.repeat(8)],
    ]
    for (const [label, key] of pinned) {
      expect(keyFromLabel(label, new Set())).toBe(key)
    }
  })

  test('de-duplicates with a numeric suffix', () => {
    expect(keyFromLabel('Billing', new Set(['billing']))).toBe('billing_2')
    expect(keyFromLabel('Billing', new Set(['billing', 'billing_2']))).toBe(
      'billing_3',
    )
  })
})

describe('moved', () => {
  test('a scale level moves with its key, and stops at either end', () => {
    expect(moved(['low', 'mid', 'high'], 2, -1)).toEqual(['low', 'high', 'mid'])
    expect(moved(['low', 'mid', 'high'], 0, -1)).toEqual(['low', 'mid', 'high'])
    expect(moved(['low', 'mid', 'high'], 2, 1)).toEqual(['low', 'mid', 'high'])
  })
})
