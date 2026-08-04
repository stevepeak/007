import { describe, expect, test } from 'bun:test'

import { interpolateUserText } from './prompt-variables'

// `interpolateUserText` fills a `${token}` template for USER-FACING copy — a
// tool's `statusLabel`, a node's `progressNote`. These cases pin the fill
// contract: a user-facing line must never leak a raw `${…}`, and non-string
// values coerce sensibly.
describe('interpolateUserText', () => {
  test('fills a token from a matching string arg', () => {
    expect(
      interpolateUserText('Searching knowledge base for “${query}”', {
        query: 'indemnification clauses',
      }),
    ).toBe('Searching knowledge base for “indemnification clauses”')
  })

  test('fills multiple tokens and coerces numbers/booleans', () => {
    expect(
      interpolateUserText('Fetching ${documentId} (page ${page}, full=${full})', {
        documentId: 'doc-1',
        page: 3,
        full: true,
      }),
    ).toBe('Fetching doc-1 (page 3, full=true)')
  })

  test('a missing or null arg resolves to empty string, never a raw token', () => {
    expect(interpolateUserText('Fetching document ${documentId}', {})).toBe(
      'Fetching document ',
    )
    expect(
      interpolateUserText('q=${query}', { query: null }),
    ).toBe('q=')
  })

  test('object args are JSON-stringified rather than [object Object]', () => {
    expect(interpolateUserText('scope=${scope}', { scope: { docType: 'nda' } })).toBe(
      'scope={"docType":"nda"}',
    )
  })

  test('non-object input yields empty tokens', () => {
    expect(interpolateUserText('Searching ${query}', undefined)).toBe('Searching ')
    expect(interpolateUserText('no tokens here', { query: 'x' })).toBe(
      'no tokens here',
    )
  })
})
