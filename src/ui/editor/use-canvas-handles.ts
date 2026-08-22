import { useCallback, useRef } from 'react'

import type { WorkflowGraph } from '../../engine'

/**
 * The imperative bridge to the xyflow canvas.
 *
 * The canvas owns its own node state, so three operations can't be expressed as
 * props: patching a single node (how the inspector writes an edit back),
 * replacing the whole graph (how an undo lands), and moving the selection (how
 * the issues dock jumps to a bad node). The canvas registers a callback for
 * each; this hook holds them and hands out the register/invoke pairs.
 *
 * The refs stay INSIDE the hook deliberately. Returning them would let a caller
 * write `state.someRef.current = fn`, which the React Compiler's immutability
 * rule rejects — correctly, since a ref handed out of a hook is shared mutable
 * state with no owner.
 */
export function useCanvasHandles() {
  const patcherRef = useRef<
    ((nodeId: string, next: WorkflowGraph['nodes'][number]) => void) | null
  >(null)
  const applyGraphRef = useRef<((g: WorkflowGraph) => void) | null>(null)
  const selectNodeRef = useRef<((nodeId: string) => void) | null>(null)

  const registerNodePatcher = useCallback(
    (patch: (nodeId: string, next: WorkflowGraph['nodes'][number]) => void) => {
      patcherRef.current = patch
    },
    [],
  )
  const registerApplyGraph = useCallback((apply: (g: WorkflowGraph) => void) => {
    applyGraphRef.current = apply
  }, [])
  const registerSelectNode = useCallback((select: (nodeId: string) => void) => {
    selectNodeRef.current = select
  }, [])

  /** Replace one node on the canvas — how the inspector writes its edits back. */
  const patchNode = useCallback((next: WorkflowGraph['nodes'][number]) => {
    patcherRef.current?.(next.id, next)
  }, [])
  /** Replace the whole graph — how an undo/redo or a version load lands. */
  const applyGraph = useCallback((g: WorkflowGraph) => {
    applyGraphRef.current?.(g)
  }, [])
  /** Move the canvas selection — how the issues dock jumps to a bad node. */
  const selectNode = useCallback((nodeId: string) => {
    selectNodeRef.current?.(nodeId)
  }, [])

  return {
    registerNodePatcher,
    registerApplyGraph,
    registerSelectNode,
    patchNode,
    applyGraph,
    selectNode,
  }
}
