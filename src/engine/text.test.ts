import { describe, expect, test } from 'bun:test'

import { firstLine, truncate } from './text'

describe('truncate', () => {
  test('returns text that fits unchanged', () => {
    expect(truncate({ text: 'abcde', max: 5 })).toBe('abcde')
    expect(truncate({ text: 'abcde', max: 5, suffix: 'count' })).toBe('abcde')
  })

  test('ellipsis fits within max and drops whitespace before the …', () => {
    expect(truncate({ text: 'abcdefgh', max: 5 })).toBe('abcd…')
    expect(truncate({ text: 'abc defgh', max: 5 })).toBe('abc…')
  })

  test('count keeps max chars and names how many were dropped', () => {
    expect(truncate({ text: 'abcdefgh', max: 5, suffix: 'count' })).toBe(
      'abcde… [truncated 3 chars]',
    )
    expect(
      truncate({ text: 'abcdefgh', max: 5, suffix: 'count', hint: 'ask' }),
    ).toBe('abcde… [truncated 3 chars — ask]')
  })
})

describe('firstLine', () => {
  test('takes the first non-empty trimmed line, truncated', () => {
    expect(firstLine('\n  hello world  \nnext', 8)).toBe('hello w…')
  })
})
