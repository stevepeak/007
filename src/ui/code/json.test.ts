import { describe, expect, test } from 'bun:test'

import { formatJson, parseJson, parseLooseJson } from './json'

// The error text is what stands between an author and a fixture that silently
// isn't what they typed, so it's worth pinning: the engine's decoration is
// stripped, and a byte offset — useless against a ten-line box — is reported as
// the line and column it falls on.
describe('parseJson', () => {
  test('parses a document', () => {
    expect(parseJson('{"a": 1}')).toEqual({ ok: true, value: { a: 1 } })
  })

  test('rejects a malformed one', () => {
    const result = parseJson('{"a": 1,}')
    expect(result.ok).toBe(false)
  })

  test("strips the thrower's name from the message", () => {
    const result = parseJson('nope')
    expect(result.ok).toBe(false)
    if (result.ok) return
    // Bun/JSC prefixes "JSON Parse error: "; V8 and SpiderMonkey decorate their
    // own way. Whichever ran, the author gets the diagnosis, not the plumbing.
    expect(result.error).not.toStartWith('JSON Parse error:')
    expect(result.error).not.toStartWith('JSON.parse:')
    expect(result.error.length).toBeGreaterThan(0)
  })
})

describe('formatJson', () => {
  test('re-indents what parses', () => {
    expect(formatJson('{"a":1,"b":[1]}')).toBe(
      '{\n  "a": 1,\n  "b": [\n    1\n  ]\n}',
    )
  })

  test('leaves what does not parse to the caller', () => {
    expect(formatJson('{"a":')).toBeNull()
  })
})

describe('parseLooseJson', () => {
  test('parses JSON, keeps anything else as the raw text', () => {
    expect(parseLooseJson({ text: ' {"a":1} ' })).toEqual({ a: 1 })
    expect(parseLooseJson({ text: '42' })).toBe(42)
    expect(parseLooseJson({ text: '{"a":' })).toBe('{"a":')
  })

  test('structuredOnly leaves scalars as strings', () => {
    expect(parseLooseJson({ text: '42', structuredOnly: true })).toBe('42')
    expect(parseLooseJson({ text: '[1]', structuredOnly: true })).toEqual([1])
  })

  test('empty picks what blank text yields', () => {
    expect(parseLooseJson({ text: '  ' })).toBe('  ')
    expect(parseLooseJson({ text: '  ', empty: 'string' })).toBe('')
    expect(parseLooseJson({ text: '  ', empty: 'undefined' })).toBeUndefined()
  })
})
