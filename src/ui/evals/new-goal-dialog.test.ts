import { describe, expect, test } from 'bun:test'

import { uniqueGoalName } from './new-goal-dialog'

// Creating a goal no longer asks for a name, so this function IS the name every
// goal starts life with. Getting a collision wrong shows up as two
// indistinguishable rows in the goals list.

describe('uniqueGoalName', () => {
  test('uses the agent name when nothing has claimed it', () => {
    expect(uniqueGoalName('Document Summarizer', [])).toBe('Document Summarizer')
    expect(uniqueGoalName('Document Summarizer', ['Other goal'])).toBe(
      'Document Summarizer',
    )
  })

  test('suffixes when the agent already has a goal', () => {
    expect(uniqueGoalName('Doc Summarizer', ['Doc Summarizer'])).toBe(
      'Doc Summarizer 2',
    )
    expect(
      uniqueGoalName('Doc Summarizer', ['Doc Summarizer', 'Doc Summarizer 2']),
    ).toBe('Doc Summarizer 3')
  })

  test('collides case- and whitespace-insensitively', () => {
    // The list renders these as the same string, so they have to count as taken.
    expect(uniqueGoalName('Doc Summarizer', ['  doc summarizer  '])).toBe(
      'Doc Summarizer 2',
    )
  })

  test('fills a gap rather than always counting to the end', () => {
    expect(
      uniqueGoalName('Doc Summarizer', ['Doc Summarizer', 'Doc Summarizer 3']),
    ).toBe('Doc Summarizer 2')
  })

  test('an unnamed agent still yields a usable name', () => {
    expect(uniqueGoalName('   ', [])).toBe('Untitled goal')
  })
})
