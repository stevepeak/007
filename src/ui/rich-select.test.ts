import { describe, expect, test } from 'bun:test'

import { filterOptions } from './rich-select'

const options = [
  { name: 'Summarizer', description: 'Condenses long documents' },
  { name: 'Classifier', description: null },
  { name: 'Router', description: 'Picks a summary style' },
]

function search(query: string) {
  return filterOptions({
    options,
    query,
    getSearchText: (o) => `${o.name} ${o.description ?? ''}`,
  }).map((o) => o.name)
}

describe('filterOptions', () => {
  test('a blank or whitespace query keeps every option', () => {
    expect(search('')).toEqual(['Summarizer', 'Classifier', 'Router'])
    expect(search('   ')).toEqual(['Summarizer', 'Classifier', 'Router'])
  })

  test('matches case-insensitively and ignores surrounding whitespace', () => {
    expect(search('  CLASS ')).toEqual(['Classifier'])
  })

  test('matches anywhere in the search text, including the description', () => {
    expect(search('summ')).toEqual(['Summarizer', 'Router'])
    expect(search('documents')).toEqual(['Summarizer'])
  })

  test('returns nothing when no option matches', () => {
    expect(search('zzz')).toEqual([])
  })
})
