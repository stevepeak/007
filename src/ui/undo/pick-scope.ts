// Which registered undo scope a keystroke goes to.
//
// Several scopes are alive at once and that is by design: `WfApp` keeps every
// open tab MOUNTED (inactive ones are `display:none`), so three open workflow
// editors mean three live undo stacks. Exactly one of them may answer Cmd+Z.

/** The undo/redo surface a scope exposes. Registration adds the bookkeeping. */
export type UndoScope = {
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
  /** Label of the change undo would revert — for a button tooltip. */
  undoLabel?: string
  /** Label of the change redo would re-apply. */
  redoLabel?: string
}

export type RegisteredScope = UndoScope & {
  /** Registration order. Higher = mounted later. */
  seq: number
  /** Nesting depth — a modal or overlay sits above the surface it covers. */
  depth: number
  /** False for a keep-alive tab that is mounted but not on screen. */
  active: boolean
  /** False while a scope is deliberately dormant (e.g. a read-only editor). */
  enabled: boolean
}

/**
 * The scope that owns undo right now, or `null` when none does.
 *
 * `null` is meaningful: the provider must NOT call `preventDefault` in that
 * case, so the browser keeps Cmd+Z and nothing is silently swallowed.
 */
export function pickScope(scopes: Iterable<RegisteredScope>): RegisteredScope | null {
  let best: RegisteredScope | null = null
  for (const scope of scopes) {
    if (!scope.enabled || !scope.active) continue
    if (
      best === null ||
      scope.depth > best.depth ||
      // Same depth — the most recently mounted surface is the one in front.
      (scope.depth === best.depth && scope.seq > best.seq)
    ) {
      best = scope
    }
  }
  return best
}
