import { describe, expect, it } from 'bun:test'

import { pushEntry, shouldCoalesce, type UndoEntry } from './undo-stack-model'

const entry = (label: string): UndoEntry<string> => ({ state: label, label })
const stack = (...labels: string[]) => labels.map(entry)
const labels = <T>(entries: UndoEntry<T>[]) => entries.map((e) => e.label)

describe('pushEntry', () => {
  it('appends at the tip', () => {
    const r = pushEntry(stack('a', 'b'), 1, entry('c'), 50)
    expect(labels(r.entries)).toEqual(['a', 'b', 'c'])
    expect(r.index).toBe(2)
    expect(r.dropped).toBe(0)
  })

  // Editing after stepping back abandons the future you stepped back from.
  it('discards the redo tail when pushing from the middle', () => {
    const r = pushEntry(stack('a', 'b', 'c', 'd'), 1, entry('e'), 50)
    expect(labels(r.entries)).toEqual(['a', 'b', 'e'])
    expect(r.index).toBe(2)
  })

  it('does not mutate the entries it was given', () => {
    const before = stack('a', 'b')
    pushEntry(before, 1, entry('c'), 50)
    expect(labels(before)).toEqual(['a', 'b'])
  })

  it('evicts from the front once the stack exceeds max', () => {
    const r = pushEntry(stack('a', 'b', 'c'), 2, entry('d'), 3)
    expect(labels(r.entries)).toEqual(['b', 'c', 'd'])
    expect(r.index).toBe(2)
    expect(r.dropped).toBe(1)
  })

  it('reports every dropped entry when several fall off at once', () => {
    const r = pushEntry(stack('a', 'b', 'c', 'd', 'e'), 4, entry('f'), 3)
    expect(labels(r.entries)).toEqual(['d', 'e', 'f'])
    expect(r.dropped).toBe(3)
  })

  // The invariant the whole `dropped` return value exists for. A caller tracking
  // the saved entry by absolute index must subtract it, or a long session
  // silently reports itself clean.
  describe('the savedIndex correction', () => {
    it('keeps a surviving savedIndex pointed at the same entry', () => {
      let savedIndex = 2
      let entries = stack('a', 'b', 'c', 'd')
      let index = 3
      expect(entries[savedIndex].label).toBe('c')

      const r = pushEntry(entries, index, entry('e'), 4)
      entries = r.entries
      index = r.index
      savedIndex -= r.dropped

      expect(entries[savedIndex].label).toBe('c')
      expect(index).not.toBe(savedIndex) // still dirty
    })

    it('goes negative — and stays dirty forever — once saved falls off', () => {
      let savedIndex = 0
      let entries = stack('saved', 'b', 'c')
      let index = 2

      for (const label of ['d', 'e', 'f']) {
        const r = pushEntry(entries, index, entry(label), 3)
        entries = r.entries
        index = r.index
        savedIndex -= r.dropped
      }

      expect(savedIndex).toBeLessThan(0)
      // The stack no longer remembers what "saved" looked like, so it can never
      // claim to be clean again.
      expect(index).not.toBe(savedIndex)
      expect(labels(entries)).not.toContain('saved')
    })
  })
})

describe('shouldCoalesce', () => {
  const base = {
    rule: { key: 'Moved "A"' },
    atTip: true,
    lastKey: 'Moved "A"',
    now: 1000,
    lastRecordedAt: 900,
  }

  it('merges a continuing gesture', () => {
    expect(shouldCoalesce(base)).toBe(true)
  })

  it('never merges without a rule', () => {
    expect(shouldCoalesce({ ...base, rule: null })).toBe(false)
  })

  it('never merges a different gesture', () => {
    expect(shouldCoalesce({ ...base, lastKey: 'Moved "B"' })).toBe(false)
  })

  it('never merges on the first edit of a gesture', () => {
    expect(shouldCoalesce({ ...base, lastKey: null })).toBe(false)
  })

  // Coalescing into the middle of a stack would rewrite history you had
  // deliberately stepped back into.
  it('never merges away from the tip', () => {
    expect(shouldCoalesce({ ...base, atTip: false })).toBe(false)
  })

  describe('the time window', () => {
    const typing = { ...base, rule: { key: 'Edited "A" settings', windowMs: 600 } }

    it('merges inside the window', () => {
      expect(
        shouldCoalesce({
          ...typing,
          lastKey: typing.rule.key,
          now: 1500,
          lastRecordedAt: 1000,
        }),
      ).toBe(true)
    })

    it('starts a new entry after a pause', () => {
      expect(
        shouldCoalesce({
          ...typing,
          lastKey: typing.rule.key,
          now: 1700,
          lastRecordedAt: 1000,
        }),
      ).toBe(false)
    })

    it('treats the boundary as still inside', () => {
      expect(
        shouldCoalesce({
          ...typing,
          lastKey: typing.rule.key,
          now: 1600,
          lastRecordedAt: 1000,
        }),
      ).toBe(true)
    })

    // A drag ends when the pointer does, not on a clock.
    it('has no time bound when the rule sets none', () => {
      expect(shouldCoalesce({ ...base, now: 999_999, lastRecordedAt: 0 })).toBe(true)
    })
  })
})
