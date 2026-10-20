import { describe, expect, test } from 'bun:test'

import { slugify, uniqueSlug } from './slug'

// A slug is the persisted, cross-environment identity of an agent, workflow or
// eval set, so the slug of a given name is frozen. This copy folds accents:
// `Café` → `cafe`.
describe('slugify', () => {
  test('pinned output', () => {
    const pinned: [string, string][] = [
      ['Café', 'cafe'],
      ['Crème Brûlée!', 'creme-brulee'],
      ['🚀 Launch 🚀', 'launch'],
      ['🚀', 'item'],
      ['Hello, World!', 'hello-world'],
      ['--leading and trailing--', 'leading-and-trailing'],
      ['__under__', 'under'],
      ['', 'item'],
      ['   ', 'item'],
      ['123 go', '123-go'],
      ['2fast', '2fast'],
      ['ÀÉÎÕÜ', 'aeiou'],
      ['ﬁle ²', 'file-2'],
      ['İstanbul', 'istanbul'],
      ['Straße', 'stra-e'],
      ['MiXeD_Case-Name', 'mixed-case-name'],
      ['tab\tnew\nline', 'tab-new-line'],
      ['a'.repeat(39) + ' b', 'a'.repeat(39) + '-b'],
      ['x'.repeat(62) + '-yz', 'x'.repeat(62) + '-yz'],
      ['word '.repeat(20), 'word-'.repeat(19) + 'word'],
    ]
    for (const [name, slug] of pinned) {
      expect(slugify(name)).toBe(slug)
    }
  })
})

describe('uniqueSlug', () => {
  test('suffixes -2, -3, … and records what it hands out', () => {
    const taken = new Set(['intake'])
    expect(uniqueSlug('intake', taken)).toBe('intake-2')
    expect(uniqueSlug('intake', taken)).toBe('intake-3')
    expect(uniqueSlug('triage', taken)).toBe('triage')
    expect(taken).toEqual(new Set(['intake', 'intake-2', 'intake-3', 'triage']))
  })
})
