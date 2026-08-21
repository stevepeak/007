import { describe, expect, test } from 'bun:test'

import { nextSwitchCaseKey } from './graph-schema'

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
