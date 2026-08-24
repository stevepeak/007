import { useEffect, useRef } from 'react'

import { useUndoTabId, useUnsavedRegistry } from './undo-context'

// Announce that a surface is holding work the server doesn't have yet.
//
// This exists because moving an editor from write-on-every-change to
// draft-then-save trades one problem for another: nothing is written behind your
// back, but now closing the tab can lose what you typed. The guard is the other
// half of that trade, and an editor should not make the move without it.
//
// Registration is scoped to the enclosing tab, so closing ONE tab only asks
// about work in that tab.

/**
 * Register this surface as unsaved while `dirty`.
 *
 * `label` names it in the confirmation — "Sample: Refund flow" reads better than
 * "you have unsaved changes" when three tabs are open.
 */
export function useUnsavedGuard(dirty: boolean, label: string): void {
  const registry = useUnsavedRegistry()
  const tabId = useUndoTabId()

  const idRef = useRef<number | null>(null)
  if (idRef.current === null && registry) idRef.current = registry.nextId()
  const id = idRef.current

  // Read through a ref so the effect below tracks `dirty` alone — the label
  // changing (a rename in progress) shouldn't churn the registration.
  const labelRef = useRef(label)
  labelRef.current = label

  useEffect(() => {
    if (!registry || id === null) return
    if (!dirty) {
      registry.clear(id)
      return
    }
    registry.set(id, { tabId, label: labelRef.current })
    return () => registry.clear(id)
  }, [registry, id, tabId, dirty])

  // Reloading or closing the browser is the same loss by another route. The
  // message is ignored by every modern browser — returnValue is what triggers
  // the prompt at all.
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])
}
