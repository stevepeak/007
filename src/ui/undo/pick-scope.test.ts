import { describe, expect, it } from 'bun:test'

import { pickScope, type RegisteredScope } from './pick-scope'

function scope(over: Partial<RegisteredScope> = {}): RegisteredScope {
  return {
    undo: () => {},
    redo: () => {},
    canUndo: true,
    canRedo: true,
    seq: 0,
    depth: 0,
    active: true,
    enabled: true,
    ...over,
  }
}

describe('pickScope', () => {
  it('returns null when nothing is registered', () => {
    expect(pickScope([])).toBeNull()
  })

  // The bug this whole module exists to fix: three keep-alive editor tabs are
  // all mounted, and only the visible one may answer Cmd+Z.
  it('ignores mounted-but-hidden tabs', () => {
    const visible = scope({ seq: 1, active: true })
    const winner = pickScope([
      scope({ seq: 2, active: false }),
      visible,
      scope({ seq: 3, active: false }),
    ])
    expect(winner).toBe(visible)
  })

  it('returns null when every scope is hidden', () => {
    expect(pickScope([scope({ active: false }), scope({ active: false })])).toBeNull()
  })

  it('skips disabled scopes', () => {
    const on = scope({ seq: 1 })
    expect(pickScope([scope({ seq: 2, enabled: false }), on])).toBe(on)
  })

  it('lets a deeper layer win — a modal covers the editor beneath it', () => {
    const modal = scope({ seq: 1, depth: 1 })
    expect(pickScope([scope({ seq: 9, depth: 0 }), modal])).toBe(modal)
  })

  it('breaks a depth tie on the most recently mounted scope', () => {
    const newer = scope({ seq: 5 })
    expect(pickScope([scope({ seq: 2 }), newer, scope({ seq: 4 })])).toBe(newer)
  })
})
