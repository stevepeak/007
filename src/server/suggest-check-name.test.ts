import { describe, expect, test } from 'bun:test'

import { cleanSuggestedName } from './suggest-check-name'

// A suggested name goes straight into a title field, so whatever the model
// hands back has to arrive already fit for it — the author sees the cleaned
// string, not the raw answer.
describe('cleanSuggestedName', () => {
  test('passes a well-formed name through untouched', () => {
    expect(cleanSuggestedName('Has correct title')).toBe('Has correct title')
  })

  test('strips the quoting and terminal punctuation models add', () => {
    expect(cleanSuggestedName('  "Mentions alimony."  ')).toBe(
      'Mentions alimony',
    )
    expect(cleanSuggestedName('“Avoids legal advice”')).toBe(
      'Avoids legal advice',
    )
  })

  test('keeps the first clause when the model answers in a sentence', () => {
    expect(
      cleanSuggestedName(
        'Cites the statute, by number, as required by the rubric',
      ),
    ).toBe('Cites the statute')
  })

  test('caps a runaway answer at title length', () => {
    const long = cleanSuggestedName('Has '.repeat(40))
    expect(long.length).toBeLessThanOrEqual(61)
    expect(long.endsWith('…')).toBe(true)
  })
})
