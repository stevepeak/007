import { describe, expect, test } from 'bun:test'

import { stableEqual, stableStringify } from './stable-stringify'

// The point of this helper is that four subsystems now answer "did this change?"
// the same way. Key ordering is the easy half; the `undefined` modes are the half
// they used to disagree on, and the half a regression would be silent in — a
// drift check that flips to `'literal'` republishes on every import, and the eval
// snapshot hash that flips to `'drop'` invalidates every stored digest.

describe('key ordering', () => {
  test('sorts object keys at every depth', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    )
  })

  test('two objects differing only in insertion order compare equal', () => {
    expect(stableEqual({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(
      true,
    )
  })

  test('array order is significant — it is data, not layout', () => {
    expect(stableEqual([1, 2], [2, 1])).toBe(false)
  })

  test('sorts by code unit, not by locale collation', () => {
    // `localeCompare` orders these the other way round under most locales, which
    // would make the hash depend on the runtime's collation.
    expect(stableStringify({ b: 1, B: 2, a: 3, A: 4 })).toBe(
      '{"A":4,"B":2,"a":3,"b":1}',
    )
  })
})

describe("undefinedKeys: 'drop' (the default)", () => {
  test('an explicitly-undefined key is absent, matching a JSON round-trip', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}')
    expect(stableEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true)
  })

  test('drops nested undefined keys too', () => {
    expect(stableEqual({ a: { b: undefined, c: 1 } }, { a: { c: 1 } })).toBe(true)
  })

  test('null is a value, not an absence', () => {
    expect(stableStringify({ a: null })).toBe('{"a":null}')
    expect(stableEqual({ a: null }, { a: undefined })).toBe(false)
    expect(stableEqual({ a: null }, {})).toBe(false)
  })

  test('is the default when no options are passed', () => {
    expect(stableStringify({ a: undefined })).toBe(
      stableStringify({ a: undefined }, { undefinedKeys: 'drop' }),
    )
  })
})

describe("undefinedKeys: 'literal'", () => {
  const literal = { undefinedKeys: 'literal' } as const

  test('keeps the key and emits the bare text `undefined`', () => {
    expect(stableStringify({ a: 1, b: undefined }, literal)).toBe(
      '{"a":1,"b":undefined}',
    )
  })

  test('an explicitly-undefined key differs from an absent one', () => {
    // The whole reason this mode is not the default — but also exactly the
    // behaviour the persisted eval-snapshot digest was computed under.
    expect(stableEqual({ a: 1, b: undefined }, { a: 1 }, literal)).toBe(false)
  })

  test('still sorts, so the frozen digest survives key reordering', () => {
    expect(stableStringify({ b: undefined, a: 1 }, literal)).toBe(
      stableStringify({ a: 1, b: undefined }, literal),
    )
  })

  test('reproduces the shape hashEvalSnapshot froze', () => {
    // `{ topic: 'law', empty: undefined }` is the nested shape
    // `eval-snapshot.test.ts` locks a digest over.
    expect(
      stableStringify({ variables: { topic: 'law', empty: undefined } }, literal),
    ).toBe('{"variables":{"empty":undefined,"topic":"law"}}')
  })
})

describe('scalars and edges', () => {
  test('always returns a string, including for a bare undefined', () => {
    // The four previous copies returned JS `undefined` here and relied on
    // template coercion to hide it, making their `: string` return type a lie.
    expect(stableStringify(undefined)).toBe('undefined')
    expect(stableStringify(undefined, { undefinedKeys: 'literal' })).toBe(
      'undefined',
    )
  })

  test('an undefined array element is rendered, not elided', () => {
    // `[undefined]` and `[]` are different lists; the old copies stringified
    // both to `[]` because `Array.prototype.join` swallows undefined.
    expect(stableStringify([undefined])).toBe('[undefined]')
    expect(stableEqual([undefined], [])).toBe(false)
  })

  test('primitives and null match JSON.stringify', () => {
    for (const v of [null, 0, -1.5, '', 'x', true, false]) {
      expect(stableStringify(v)).toBe(JSON.stringify(v))
    }
  })

  test('strings are quoted and escaped, so a key cannot forge a delimiter', () => {
    expect(stableStringify({ 'a":1,"b': 2 })).toBe(String.raw`{"a\":1,\"b":2}`)
  })

  test('empty containers', () => {
    expect(stableStringify({})).toBe('{}')
    expect(stableStringify([])).toBe('[]')
  })
})
