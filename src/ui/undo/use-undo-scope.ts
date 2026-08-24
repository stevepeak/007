import { useEffect, useRef } from 'react'

import type { RegisteredScope, UndoScope } from './pick-scope'
import { useUndoActive, useUndoDepth, useUndoRegistry } from './undo-context'

export type UseUndoScopeOptions = UndoScope & {
  /** Set false to stay registered but dormant (e.g. a read-only editor). */
  enabled?: boolean
}

/**
 * Registers this surface as an undo target. One line in an editor, and Cmd+Z
 * works there — with no listener of its own, so multiple mounted editors can't
 * fight over the same keystroke.
 *
 * The scope is re-published on every render (its callbacks close over fresh
 * state) but registration itself happens once, so a re-render never causes a
 * re-subscribe. Registration is effect-timed, so a Cmd+Z landing in the very
 * first paint falls through to the browser — harmless, and not worth a layout
 * effect to close.
 */
export function useUndoScope(opts: UseUndoScopeOptions): void {
  const registry = useUndoRegistry()
  const depth = useUndoDepth()
  const active = useUndoActive()

  const idRef = useRef<number | null>(null)
  if (idRef.current === null && registry) idRef.current = registry.nextId()
  const id = idRef.current

  // Keep the registered scope current. Not an effect dependency list: the
  // callbacks change identity every render, and re-registering is the point.
  const current: RegisteredScope = {
    undo: opts.undo,
    redo: opts.redo,
    canUndo: opts.canUndo,
    canRedo: opts.canRedo,
    undoLabel: opts.undoLabel,
    redoLabel: opts.redoLabel,
    enabled: opts.enabled ?? true,
    depth,
    active,
    seq: id ?? 0,
  }
  const currentRef = useRef(current)
  currentRef.current = current

  useEffect(() => {
    if (!registry || id === null) return
    return registry.register(id, currentRef.current)
    // Registering once per mount is deliberate — `update` below carries changes.
  }, [registry, id])

  // Publish the latest callbacks/flags into the registry after each render.
  useEffect(() => {
    if (!registry || id === null) return
    registry.update(id, currentRef.current)
  })
}
