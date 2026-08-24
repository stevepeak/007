import { useReducer, useRef, useState } from 'react'

import {
  pushEntry,
  shouldCoalesce,
  type CoalesceRule,
  type UndoEntry,
} from './undo-stack-model'
import { useUndoScope } from './use-undo-scope'

// The undo engine, over any editable value.
//
// This is `useEditHistory` with the workflow graph lifted out of it. The shape
// was already right — a snapshot stack, an index, a `savedIndex` for dirty
// tracking, and an `applying` flag so re-applying a snapshot doesn't record
// itself as a new edit. What it wasn't was reusable, so the agent editor went
// without undo entirely and the eval editors never had a stack to put edits in.
//
// Two things are new. `coalesce` turns the old hardcoded "a Moved after a Moved
// replaces it" special case into a rule the caller supplies, which is what makes
// per-keystroke edits survivable: without it, typing fifty characters into one
// field pushed fifty snapshots and evicted the entire history. And `onApply` is
// the channel for state a snapshot can't reach on its own — an xyflow canvas, a
// TipTap document — so restoring is one call rather than a protocol.

export type { CoalesceRule, UndoEntry }

export type ApplyDirection = 'undo' | 'redo' | 'jump' | 'load'

export type UndoStackOptions<T> = {
  initial: T
  /** Label for the seeded entry. Defaults to 'Opened'. */
  initialLabel?: string
  /** Cap on retained entries; past it the oldest are forgotten. Default 50. */
  max?: number
  /** Short human description of what an edit did, for the History dropdown. */
  describe: (prev: T, next: T) => string
  /** Whether this edit merges into the previous one. Default: never. */
  coalesce?: (prev: T, next: T, label: string) => CoalesceRule
  /** Push a restored value into state a snapshot can't reach by itself. */
  onApply?: (state: T, direction: ApplyDirection) => void
  /**
   * Stay registered but dormant — for a surface that is mounted before it has
   * anything to edit. A disabled scope never claims the keystroke, so it can't
   * swallow Cmd+Z from whatever else is on screen.
   */
  enabled?: boolean
}

const DEFAULT_MAX_HISTORY = 50

export function useUndoStack<T>(opts: UndoStackOptions<T>) {
  const {
    initial,
    initialLabel = 'Opened',
    max = DEFAULT_MAX_HISTORY,
    describe,
    coalesce,
    onApply,
    enabled = true,
  } = opts

  const [state, setState] = useState<T>(initial)

  const entriesRef = useRef<UndoEntry<T>[]>([{ state: initial, label: initialLabel }])
  const indexRef = useRef(0)
  // Set while we re-apply a snapshot, so the echo a controlled surface sends
  // back (the canvas re-emits its own graph) isn't recorded as a fresh edit.
  const applyingRef = useRef(false)
  // When the tip entry was last written — for the coalescing window. Only ever
  // read and written in handlers; reading the clock during render is impure.
  const lastRecordedAtRef = useRef(0)
  const lastCoalesceKeyRef = useRef<string | null>(null)

  // Which index reflects the last-saved state (drives `dirty`).
  const [savedIndex, setSavedIndex] = useState(0)
  // Refs alone don't re-render, and the toolbar reads them.
  const [, bump] = useReducer((n: number) => n + 1, 0)

  /** Append an entry, dropping any redo tail and the oldest entries past `max`. */
  function push(entry: UndoEntry<T>) {
    const result = pushEntry(entriesRef.current, indexRef.current, entry, max)
    entriesRef.current = result.entries
    indexRef.current = result.index
    // Eviction shifts every absolute index down, and `savedIndex` is one.
    if (result.dropped) setSavedIndex((s) => s - result.dropped)
    bump()
  }

  /** Replace the tip entry in place — the coalescing case. */
  function replaceTip(entry: UndoEntry<T>) {
    const copy = entriesRef.current.slice()
    copy[indexRef.current] = entry
    entriesRef.current = copy
  }

  /**
   * The normal edit funnel. Records `next` as a new entry, or merges it into the
   * one before when `coalesce` says they're the same gesture.
   */
  function record(next: T) {
    setState(next)
    if (applyingRef.current) {
      applyingRef.current = false
      return
    }
    const prev = entriesRef.current[indexRef.current]
    const label = prev ? describe(prev.state, next) : 'Edited'
    const rule = prev ? (coalesce?.(prev.state, next, label) ?? null) : null
    // Read the clock HERE, in the handler. `Date.now()` during render is impure
    // and the React Compiler rejects it.
    const now = Date.now()

    if (
      shouldCoalesce({
        rule,
        atTip: indexRef.current === entriesRef.current.length - 1,
        lastKey: lastCoalesceKeyRef.current,
        now,
        lastRecordedAt: lastRecordedAtRef.current,
      })
    ) {
      lastRecordedAtRef.current = now
      replaceTip({ state: next, label })
      return
    }

    lastCoalesceKeyRef.current = rule?.key ?? null
    lastRecordedAtRef.current = now
    push({ state: next, label })
  }

  /** Move to an absolute index — an undo, a redo, or a History dropdown click. */
  function applyIndex(index: number, direction: ApplyDirection = 'jump') {
    const entry = entriesRef.current[index]
    if (!entry) return
    indexRef.current = index
    applyingRef.current = true
    // A jump ends any gesture in progress, so the next edit starts a new entry.
    lastCoalesceKeyRef.current = null
    onApply?.(entry.state, direction)
    setState(entry.state)
    bump()
  }

  /**
   * Load a value as a fresh, undoable entry — a version load or a restore. The
   * point is that it is NOT a one-way door: it lands on the stack, so Cmd+Z
   * takes you back to what you had.
   */
  function load(entry: UndoEntry<T>) {
    applyingRef.current = true
    lastCoalesceKeyRef.current = null
    onApply?.(entry.state, 'load')
    setState(entry.state)
    push(entry)
  }

  function reset(next: T, label = initialLabel) {
    entriesRef.current = [{ state: next, label }]
    indexRef.current = 0
    applyingRef.current = false
    lastCoalesceKeyRef.current = null
    setSavedIndex(0)
    setState(next)
    bump()
  }

  function undo() {
    if (indexRef.current > 0) applyIndex(indexRef.current - 1, 'undo')
  }
  function redo() {
    if (indexRef.current < entriesRef.current.length - 1) {
      applyIndex(indexRef.current + 1, 'redo')
    }
  }

  const affordances = {
    canUndo: indexRef.current > 0,
    canRedo: indexRef.current < entriesRef.current.length - 1,
    undoLabel: entriesRef.current[indexRef.current]?.label,
    redoLabel: entriesRef.current[indexRef.current + 1]?.label,
  }

  // Registered, not subscribed — `WfUndoProvider` owns the only keydown
  // listener and decides which mounted surface answers.
  useUndoScope({ undo, redo, ...affordances, enabled })

  return {
    state,
    entries: entriesRef.current,
    index: indexRef.current,
    dirty: indexRef.current !== savedIndex,
    record,
    push,
    load,
    applyIndex,
    undo,
    redo,
    ...affordances,
    /** Mark the current index as the last-saved state (clears `dirty`). */
    markSaved: () => setSavedIndex(indexRef.current),
    /**
     * Re-seed the stack, discarding its history — for a surface that mounts
     * before the thing it edits has loaded.
     *
     * Not `load`, which APPENDS: that would leave the placeholder the stack was
     * created with sitting underneath as a real history entry, and one Cmd+Z too
     * many would restore it and blank the editor.
     */
    reset,
  }
}
