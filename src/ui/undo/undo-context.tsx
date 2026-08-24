import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { pickScope, type RegisteredScope, type UndoScope } from './pick-scope'
import { undoIntent, undoOwner } from './undo-keys'

// ONE window keydown listener for the whole SDK, routed to the surface the user
// is actually looking at.
//
// This replaces a listener that used to live inside `useEditHistory`. That was
// fine while the workflow editor was the only thing with undo, and wrong the
// moment tabs became keep-alive: `WfApp` mounts every open tab and hides the
// inactive ones with `display:none`, so N open editors registered N listeners
// and one Cmd+Z undid in all of them. Registration replaces subscription — a
// scope says it exists, and `pickScope` decides which one answers.

type Registry = {
  register: (id: number, scope: RegisteredScope) => () => void
  /** Re-publish a live registration — scopes re-render constantly. */
  update: (id: number, scope: RegisteredScope) => void
  nextId: () => number
}

// Two contexts, deliberately. The registry is STABLE for the provider's whole
// life, so registering never re-renders the tree beneath it. The winning scope
// is published separately, so the handful of components that show undo
// affordances re-render and nothing else does.
const RegistryContext = createContext<Registry | null>(null)
const ActiveScopeContext = createContext<UndoScope | null>(null)

/** Nesting depth. A modal or overlay sits above the surface it covers. */
const DepthContext = createContext(0)

/** Whether the enclosing keep-alive tab is the visible one. */
const ActiveContext = createContext(true)

// What a consumer of `useActiveUndoScope` can actually see. Comparing THIS —
// rather than object identity — is what keeps `update()` on every render from
// looping: the registered scope is a fresh object each time, but its signature
// only moves when something worth re-rendering for has changed.
function signature(scope: RegisteredScope | null): string {
  if (!scope) return ''
  return [
    scope.seq,
    scope.canUndo,
    scope.canRedo,
    scope.undoLabel ?? '',
    scope.redoLabel ?? '',
  ].join(' ')
}

export function WfUndoProvider({ children }: { children: ReactNode }) {
  // Registrations live in a ref, not state: a scope re-registers on every render
  // of its owner, and routing a keystroke must not wait for a render.
  const scopesRef = useRef(new Map<number, RegisteredScope>())
  const idRef = useRef(0)

  const [active, setActive] = useState<UndoScope | null>(null)
  const signatureRef = useRef('')

  const syncWinner = useCallback(() => {
    const winner = pickScope(scopesRef.current.values())
    const next = signature(winner)
    if (next === signatureRef.current) return
    signatureRef.current = next
    setActive(
      winner && {
        undo: winner.undo,
        redo: winner.redo,
        canUndo: winner.canUndo,
        canRedo: winner.canRedo,
        undoLabel: winner.undoLabel,
        redoLabel: winner.redoLabel,
      },
    )
  }, [])

  const registry = useMemo<Registry>(
    () => ({
      nextId: () => ++idRef.current,
      register: (id, scope) => {
        scopesRef.current.set(id, scope)
        syncWinner()
        return () => {
          scopesRef.current.delete(id)
          syncWinner()
        }
      },
      update: (id, scope) => {
        scopesRef.current.set(id, scope)
        syncWinner()
      },
    }),
    [syncWinner],
  )

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const intent = undoIntent(e)
      if (!intent) return
      // A rich-text editor or plain field owns its own undo — leave it alone
      // and, crucially, don't preventDefault.
      if (undoOwner(e.target) === 'native') return
      const scope = pickScope(scopesRef.current.values())
      if (!scope) return
      // Claim the key whenever a scope owns it, even at the end of the stack.
      // Falling through at that point would undo text in some field the user
      // isn't looking at, which reads as a glitch rather than as a limit.
      e.preventDefault()
      if (intent === 'undo') {
        if (scope.canUndo) scope.undo()
      } else if (scope.canRedo) {
        scope.redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <RegistryContext.Provider value={registry}>
      <ActiveScopeContext.Provider value={active}>
        {children}
      </ActiveScopeContext.Provider>
    </RegistryContext.Provider>
  )
}

/**
 * Marks its subtree as sitting ABOVE whatever it covers, so a modal's undo wins
 * over the editor behind it. Nests — depth accumulates.
 */
export function UndoLayer({ children }: { children: ReactNode }) {
  const depth = useContext(DepthContext)
  const next = useMemo(() => depth + 1, [depth])
  return <DepthContext.Provider value={next}>{children}</DepthContext.Provider>
}

/**
 * Declares whether the enclosing keep-alive tab is the one on screen. Scopes
 * inside an inactive tab stay registered — they keep their stacks — but never
 * win a keystroke.
 *
 * Defaults to `true` when absent, so an editor mounted directly by a host (with
 * no tab shell around it) still gets undo.
 */
export function UndoTabScope({
  active,
  children,
}: {
  active: boolean
  children: ReactNode
}) {
  return (
    <ActiveContext.Provider value={active}>{children}</ActiveContext.Provider>
  )
}

export function useUndoRegistry() {
  return useContext(RegistryContext)
}

export function useUndoDepth() {
  return useContext(DepthContext)
}

export function useUndoActive() {
  return useContext(ActiveContext)
}

/**
 * The scope that owns undo right now — for Undo/Redo affordances that should
 * reflect whatever surface is focused rather than one specific editor.
 */
export function useActiveUndoScope(): UndoScope | null {
  return useContext(ActiveScopeContext)
}
