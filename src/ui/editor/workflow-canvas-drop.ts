import { useReactFlow } from '@xyflow/react'
import { useCallback, type DragEvent as ReactDragEvent } from 'react'

import { PALETTE_DATA_TYPE } from './node-palette'
import {
  editorTypeForKind,
  type EditorNodeData,
} from './node-renderers'
import {
  BOOKEND_KINDS,
  DEFAULT_ITER_H,
  DEFAULT_ITER_W,
  DEFAULT_NOTE_H,
  DEFAULT_NOTE_W,
  edgeToFlow,
  extractEditorData,
  orderParentsFirst,
  type EditorEdge,
  type EditorNode,
} from './workflow-canvas-graph'
import { defaultDataForKind, type NodeDefaults } from './workflow-canvas-palette'

// MEMBERSHIP: which node belongs to which iteration container, and how a node
// gets there. There are exactly two ways in — dropping from the palette over a
// container, and dragging an existing node onto one — and this module owns both
// so they can't drift apart.
//
// Joining is ONE-WAY. Children carry `extent: 'parent'`, so a node inside a
// loop can be moved around but never dragged back out past the boundary; to
// take a node out of a loop you delete it and re-add it. Containers don't nest,
// and notes never join one.

/**
 * Keep a freshly adopted child fully inside its container. React Flow enforces
 * `extent: 'parent'` on every subsequent drag, but not on the frame where the
 * node joins — without this a node dropped half-over the edge renders outside it.
 */
export function clampInside(
  rel: { x: number; y: number },
  node: { width?: number; height?: number } | undefined,
  container: { width?: number; height?: number } | undefined,
): { x: number; y: number } {
  if (!container?.width || !container.height) return rel
  const maxX = Math.max(0, container.width - (node?.width ?? 0))
  const maxY = Math.max(0, container.height - (node?.height ?? 0))
  return {
    x: Math.min(Math.max(rel.x, 0), maxX),
    y: Math.min(Math.max(rel.y, 0), maxY),
  }
}

export type CanvasDropOptions = {
  /** Model/tool ids for freshly-dragged nodes, sourced from the host. */
  defaults?: NodeDefaults
  setNodes: React.Dispatch<React.SetStateAction<EditorNode[]>>
  setEdges: React.Dispatch<React.SetStateAction<EditorEdge[]>>
}

export function useCanvasDrop({ defaults, setNodes, setEdges }: CanvasDropOptions) {
  const { screenToFlowPosition, getIntersectingNodes, getInternalNode } =
    useReactFlow()

  const handleDragOver = useCallback((event: ReactDragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const handleDrop = useCallback(
    (event: ReactDragEvent) => {
      event.preventDefault()
      const kind = event.dataTransfer.getData(PALETTE_DATA_TYPE)
      if (!kind) return
      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      })
      const newData = defaultDataForKind(kind, defaults)
      if (!newData) return

      // Dropping an iteration adds the container plus its Item/Result bookend
      // children (flattened) and their connecting edge.
      if (newData.kind === 'iteration') {
        const containerId = crypto.randomUUID()
        const sub = newData.config.subgraph
        const container: EditorNode = {
          id: containerId,
          type: editorTypeForKind('iteration'),
          position,
          deletable: true,
          data: newData,
          style: { width: DEFAULT_ITER_W, height: DEFAULT_ITER_H },
        }
        const children: EditorNode[] = sub.nodes.map((child) => ({
          id: child.id,
          type: editorTypeForKind(child.kind),
          position: child.position,
          parentId: containerId,
          extent: 'parent',
          deletable: !BOOKEND_KINDS.has(child.kind),
          data: extractEditorData(child),
        }))
        setNodes((ns) => [...ns, container, ...children])
        setEdges((es) => [...es, ...sub.edges.map(edgeToFlow)])
        return
      }

      // A sticky Note is a free-floating annotation — it's never part of the
      // graph or an iteration loop, so it always lands top-level, pre-sized.
      if (newData.kind === 'note') {
        setNodes((ns) => [
          ...ns,
          {
            id: crypto.randomUUID(),
            type: editorTypeForKind('note'),
            position,
            data: newData,
            style: { width: DEFAULT_NOTE_W, height: DEFAULT_NOTE_H },
          },
        ])
        return
      }

      // Dropping any other node over a container makes it a member of that loop.
      const container = getIntersectingNodes({
        x: position.x,
        y: position.y,
        width: 1,
        height: 1,
      }).find((n) => (n.data as EditorNodeData).kind === 'iteration')
      const id = crypto.randomUUID()
      if (container) {
        const cAbs =
          getInternalNode(container.id)?.internals.positionAbsolute ??
          container.position
        setNodes((ns) =>
          orderParentsFirst([
            ...ns,
            {
              id,
              type: editorTypeForKind(newData.kind),
              position: { x: position.x - cAbs.x, y: position.y - cAbs.y },
              parentId: container.id,
              extent: 'parent',
              data: newData,
            },
          ]),
        )
        return
      }
      setNodes((ns) => [
        ...ns,
        { id, type: editorTypeForKind(newData.kind), position, data: newData },
      ])
    },
    [
      screenToFlowPosition,
      setNodes,
      setEdges,
      defaults,
      getIntersectingNodes,
      getInternalNode,
    ],
  )

  // Membership by containment: when an EXISTING node is dropped over a
  // container it becomes that container's child (part of the loop).
  const handleNodeDragStop = useCallback(
    (_: unknown, dragged: EditorNode) => {
      // Notes are free-floating annotations; never fold one into a loop container.
      if (dragged.data.kind === 'iteration' || dragged.data.kind === 'note')
        return
      // Already inside a loop — `extent: 'parent'` keeps it there, nothing to do.
      if (dragged.parentId) return
      const absPos =
        getInternalNode(dragged.id)?.internals.positionAbsolute ??
        dragged.position
      const container = getIntersectingNodes(dragged).find(
        (n) => (n.data as EditorNodeData).kind === 'iteration',
      )
      if (!container) return
      const cAbs =
        getInternalNode(container.id)?.internals.positionAbsolute ??
        container.position
      const rel = clampInside(
        { x: absPos.x - cAbs.x, y: absPos.y - cAbs.y },
        getInternalNode(dragged.id)?.measured,
        getInternalNode(container.id)?.measured,
      )
      setNodes((ns) =>
        orderParentsFirst(
          ns.map((n) =>
            n.id === dragged.id
              ? { ...n, parentId: container.id, extent: 'parent', position: rel }
              : n,
          ),
        ),
      )
    },
    [getIntersectingNodes, getInternalNode, setNodes],
  )

  return { handleDragOver, handleDrop, handleNodeDragStop }
}
