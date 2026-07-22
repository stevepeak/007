import { useEffect, useRef, useState } from 'react'

/**
 * Local mirror + commit-on-blur for a controlled field. Mirrors the external
 * `value` in local state so typing stays smooth, re-syncs from `value` when it
 * changes — a `useRef`'d "synced" key guards the re-sync so a background
 * refetch can't clobber an in-progress edit — and pushes the local value up via
 * `onCommit` only when it actually differs from the last synced/committed value.
 *
 * `toKey` maps a value to the comparable marker stored in the guard; override it
 * for non-primitive values (e.g. `JSON.stringify` for an object mirror).
 */
export function useCommittedField<T>(
  value: T,
  onCommit: (next: T) => void,
  toKey: (value: T) => unknown = (v) => v,
): {
  value: T
  onChange: (next: T) => void
  onBlur: () => void
  commit: (next: T) => void
} {
  const [local, setLocal] = useState(value)
  const syncedRef = useRef(toKey(value))

  const key = toKey(value)
  useEffect(() => {
    if (key !== syncedRef.current) {
      setLocal(value)
      syncedRef.current = key
    }
  }, [key, value])

  return {
    value: local,
    onChange: setLocal,
    // Conditional commit of the current local value (the blur dance).
    onBlur: () => {
      const k = toKey(local)
      if (k !== syncedRef.current) {
        syncedRef.current = k
        onCommit(local)
      }
    },
    // Set local to `next` and publish it up unconditionally — for programmatic
    // edits (e.g. removing a field) that commit immediately rather than on blur.
    commit: (next: T) => {
      setLocal(next)
      syncedRef.current = toKey(next)
      onCommit(next)
    },
  }
}
