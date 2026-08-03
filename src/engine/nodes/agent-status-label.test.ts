import { describe, expect, test } from 'bun:test'

import { interpolateStatus } from './agent-generation'

// A tool's `statusLabel` is a `${arg}` template filled from the tool call's
// input at runtime, then streamed to the user when the placement exposes
// thinking. These cases pin the fill contract: a user-facing line must never
// leak a raw `${…}`, and non-string args coerce sensibly.
describe('interpolateStatus', () => {
  test('fills a token from a matching string arg', () => {
    expect(
      interpolateStatus('Searching knowledge base for “${query}”', {
        query: 'indemnification clauses',
      }),
    ).toBe('Searching knowledge base for “indemnification clauses”')
  })

  test('fills multiple tokens and coerces numbers/booleans', () => {
    expect(
      interpolateStatus('Fetching ${documentId} (page ${page}, full=${full})', {
        documentId: 'doc-1',
        page: 3,
        full: true,
      }),
    ).toBe('Fetching doc-1 (page 3, full=true)')
  })

  test('a missing or null arg resolves to empty string, never a raw token', () => {
    expect(interpolateStatus('Fetching document ${documentId}', {})).toBe(
      'Fetching document ',
    )
    expect(
      interpolateStatus('q=${query}', { query: null }),
    ).toBe('q=')
  })

  test('object args are JSON-stringified rather than [object Object]', () => {
    expect(interpolateStatus('scope=${scope}', { scope: { docType: 'nda' } })).toBe(
      'scope={"docType":"nda"}',
    )
  })

  test('non-object input yields empty tokens', () => {
    expect(interpolateStatus('Searching ${query}', undefined)).toBe('Searching ')
    expect(interpolateStatus('no tokens here', { query: 'x' })).toBe(
      'no tokens here',
    )
  })
})
