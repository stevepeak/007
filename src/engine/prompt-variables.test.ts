import { describe, expect, test } from 'bun:test'

import {
  inferPromptVariables,
  interpolateUserText,
  promptVariableName,
  substitutePromptVariables,
  unescapePromptVariables,
} from './prompt-variables'

// The `${token}` grammar: letters, digits, `_` and `-`, no spaces — and it has
// to read the backslash escapes the Markdown editor's serializer inserts, which
// is what made `${my_var}` silently unbindable (ART-49).
describe('the `${token}` grammar', () => {
  test('accepts letters, digits, underscore and hyphen', () => {
    expect(inferPromptVariables('${title} ${doc_text} ${case-id} ${v2}')).toEqual([
      'title',
      'doc_text',
      'case-id',
      'v2',
    ])
  })

  test('rejects spaces, so a stray `${` cannot swallow prose', () => {
    expect(inferPromptVariables('${my var} and ${} and ${a b c}')).toEqual([])
    expect(substitutePromptVariables('${my var}', { 'my var': 'x' })).toBe(
      '${my var}',
    )
  })

  test('reads a name through the editor’s Markdown escapes', () => {
    // What `@tiptap/markdown` stores when the author types `${my_var}`.
    expect(inferPromptVariables('Summarize ${my\\_var}')).toEqual(['my_var'])
    expect(
      substitutePromptVariables('Summarize ${my\\_var}', { my_var: 'the NDA' }),
    ).toBe('Summarize the NDA')
  })

  test('an escape that does not spell a valid name is left verbatim', () => {
    expect(promptVariableName('a\\*b')).toBeNull()
    expect(substitutePromptVariables('${a\\*b}', { 'a*b': 'x' })).toBe('${a\\*b}')
  })

  test('an unbound token survives intact rather than emptying', () => {
    expect(substitutePromptVariables('${title} — ${missing}', { title: 'NDA' })).toBe(
      'NDA — ${missing}',
    )
  })
})

// `unescapePromptVariables` runs where Markdown leaves the editor, so stored
// bodies carry the name the author typed instead of the serializer's escape.
describe('unescapePromptVariables', () => {
  test('cleans the escape inside a variable', () => {
    expect(unescapePromptVariables('Summarize ${my\\_var} now')).toBe(
      'Summarize ${my_var} now',
    )
  })

  test('leaves Markdown escapes outside a variable alone', () => {
    expect(unescapePromptVariables('use snake\\_case and \\*stars\\*')).toBe(
      'use snake\\_case and \\*stars\\*',
    )
  })

  test('leaves braces that are not variables alone', () => {
    expect(unescapePromptVariables('${a \\* b}')).toBe('${a \\* b}')
  })

  test('keeps an edge underscore escaped — unescaped it cannot round-trip', () => {
    // `${_a}` … `${b_}` re-parses as emphasis, eating both underscores, so the
    // escape is the only representation that survives the editor. The engine
    // reads it either way.
    expect(unescapePromptVariables('${\\_lead} ${trail\\_}')).toBe(
      '${\\_lead} ${trail\\_}',
    )
    expect(inferPromptVariables('${\\_lead} ${trail\\_}')).toEqual([
      '_lead',
      'trail_',
    ])
  })

  test('is a no-op on a body with no escapes', () => {
    expect(unescapePromptVariables('Summarize ${doc} for ${client}')).toBe(
      'Summarize ${doc} for ${client}',
    )
  })
})

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
