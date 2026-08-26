import { describe, expect, test } from 'bun:test'

import { nextSwitchCaseKey, switchArmName } from './graph-schema'

// Case keys are edge labels, so what matters is that minting one never disturbs
// the keys already in use — removing a case must not re-letter its siblings.
describe('nextSwitchCaseKey', () => {
  test('walks the alphabet from A', () => {
    expect(nextSwitchCaseKey([])).toBe('A')
    expect(nextSwitchCaseKey(['A'])).toBe('B')
    expect(nextSwitchCaseKey(['A', 'B'])).toBe('C')
  })

  test('fills the gap a removed case leaves rather than re-lettering', () => {
    expect(nextSwitchCaseKey(['A', 'C'])).toBe('B')
  })

  test('rolls past Z into the two-letter range', () => {
    const alphabet = Array.from({ length: 26 }, (_, i) =>
      String.fromCharCode(65 + i),
    )
    expect(nextSwitchCaseKey(alphabet)).toBe('AA')
    expect(nextSwitchCaseKey([...alphabet, 'AA'])).toBe('AB')
  })

  test('never mints the reserved fallback key', () => {
    // Legacy graphs can carry authored keys; the fallback arm is still reserved.
    expect(nextSwitchCaseKey(['else'])).toBe('A')
  })
})

// What an arm READS as, which is a separate question from what it routes on.
describe('switchArmName', () => {
  const cases = [
    { key: 'A', label: 'image' },
    { key: 'B' },
    { key: 'C', label: '  ' },
  ]

  test('prefers the author name over the minted letter', () => {
    expect(switchArmName(cases, 'A')).toBe('image')
  })

  test('falls back to the letter when unnamed or blank', () => {
    expect(switchArmName(cases, 'B')).toBe('B')
    // A field the author cleared to spaces is not a name.
    expect(switchArmName(cases, 'C')).toBe('C')
  })

  test('leaves the fallback arm and unknown keys as themselves', () => {
    expect(switchArmName(cases, 'else')).toBe('else')
    expect(switchArmName(cases, 'Z')).toBe('Z')
    expect(switchArmName(cases, null)).toBe('')
  })
})
