import { type RefObject, useEffect } from 'react'

// Dismiss-on-outside-interaction for popovers/dropdowns. While `isOpen`, a
// `mousedown` anywhere outside `ref` (and pressing Escape) calls `onClose`.
// Listeners are only installed while open — the exact hand-rolled pattern this
// replaces across the pickers/dropdowns.
export function useDismiss<T extends Node>(
  ref: RefObject<T | null>,
  isOpen: boolean,
  onClose: () => void,
) {
  useEffect(() => {
    if (!isOpen) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [ref, isOpen, onClose])
}
