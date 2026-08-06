import { describe, expect, test } from 'bun:test'

import { fmt, humanTokens, usd } from './format-tokens'

describe('humanTokens', () => {
  test('reads magnitudes the way the field states them', () => {
    expect(humanTokens(2_000_000)).toBe('2 Million')
    expect(humanTokens(1_500_000)).toBe('1.5 Million')
    expect(humanTokens(131_072)).toBe('131K')
    expect(humanTokens(1_000)).toBe('1K')
    expect(humanTokens(4_000_000_000)).toBe('4 Billion')
  })

  test('below 1K it stays exact — no misleading rounding to 0K', () => {
    expect(humanTokens(999)).toBe('999')
    expect(humanTokens(0)).toBe('0')
  })
})

describe('usd', () => {
  test('a budget that costs something never reads as free', () => {
    // "$0.00" on a real cost is the one output that would actively mislead.
    expect(usd(0.004)).toBe('<$0.01')
    expect(usd(0)).toBe('$0.00')
    expect(usd(3)).toBe('$3.00')
    expect(usd(12.345)).toBe('$12.35')
  })
})

describe('fmt', () => {
  test('exact counts stay exact', () => {
    expect(fmt(288_000)).toBe('288,000')
  })
})
