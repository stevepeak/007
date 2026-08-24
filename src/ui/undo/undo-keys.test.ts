import { describe, expect, it } from 'bun:test'

import { resolveUndoOwner, undoIntent } from './undo-keys'

function key(
  k: string,
  mods: Partial<{
    metaKey: boolean
    ctrlKey: boolean
    shiftKey: boolean
    altKey: boolean
  }> = {},
) {
  return {
    key: k,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  }
}

describe('undoIntent', () => {
  it('reads the undo and redo chords on both platforms', () => {
    expect(undoIntent(key('z', { metaKey: true }))).toBe('undo')
    expect(undoIntent(key('z', { ctrlKey: true }))).toBe('undo')
    expect(undoIntent(key('z', { metaKey: true, shiftKey: true }))).toBe('redo')
    expect(undoIntent(key('y', { ctrlKey: true }))).toBe('redo')
  })

  it('is case-insensitive (shift uppercases the key)', () => {
    expect(undoIntent(key('Z', { metaKey: true, shiftKey: true }))).toBe('redo')
  })

  it('ignores everything that is not an undo chord', () => {
    expect(undoIntent(key('z'))).toBeNull()
    expect(undoIntent(key('s', { metaKey: true }))).toBeNull()
    expect(undoIntent(key('Enter', { metaKey: true }))).toBeNull()
  })

  it('leaves Alt chords alone — they belong to other layouts', () => {
    expect(undoIntent(key('z', { ctrlKey: true, altKey: true }))).toBeNull()
  })
})

describe('resolveUndoOwner', () => {
  it('gives unmarked non-editable surfaces to the app', () => {
    expect(resolveUndoOwner({ marker: null, editable: false })).toBe('app')
  })

  it('leaves unmarked text fields to the browser', () => {
    expect(resolveUndoOwner({ marker: null, editable: true })).toBe('native')
  })

  // The two cases the default rule gets wrong, and the only reason markers exist.
  it('lets a native island keep undo even when it is not a text field', () => {
    expect(resolveUndoOwner({ marker: 'native', editable: false })).toBe('native')
  })

  it('hands a marked app field back to the app', () => {
    expect(resolveUndoOwner({ marker: 'app', editable: true })).toBe('app')
  })
})
