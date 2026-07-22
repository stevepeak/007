import '@xyflow/react/dist/style.css'

import {
  addEdge,
  Background,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
} from '@xyflow/react'
import { LayoutGrid } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type DragEvent as ReactDragEvent,
} from 'react'

import { type WorkflowGraph, type WorkflowNode } from '../../engine'
import { useWfComponents } from '../context'
import { Tooltip } from '../tooltip'
import {
  editorTypeForKind,
  InvalidNodesProvider,
  NODE_TYPES,
  RunStatusProvider,
  type EditorNodeData,
} from './node-renderers'
import { PALETTE_DATA_TYPE } from './node-palette'
import {
  BOOKEND_KINDS,
  DEFAULT_ITER_H,
  DEFAULT_ITER_W,
  DEFAULT_NOTE_H,
  DEFAULT_NOTE_W,
  edgeToFlow,
  engineToFlow,
  extractEditorData,
  flowToEngine,
  orderParentsFirst,
  type EditorEdge,
  type EditorNode,
} from './workflow-canvas-graph'
import { layoutNodes } from './workflow-canvas-layout'
import { defaultDataForKind, type NodeDefaults } from './workflow-canvas-palette'

export type { NodeDefaults } from './workflow-canvas-palette'

// Stable empty set so the provider value doesn't change identity each render
// when no invalid ids are passed.
const EMPTY_INVALID: ReadonlySet<string> = new Set()

// Stable empty map so the run-status provider keeps identity in the editor.
const EMPTY_STATUSES: ReadonlyMap<string, string> = new Map()

export interface WorkflowCanvasProps {
  graph: WorkflowGraph
  readOnly?: boolean
  defaults?: NodeDefaults
  /** Node ids with a blocking issue — highlighted on the canvas. */
  invalidNodeIds?: ReadonlySet<string>
  /** Run-view only: nodeId → run status, tinting nodes + showing status dots. */
  nodeStatuses?: ReadonlyMap<string, string>
  /** Fired after each change with the current engine graph. */
  onChange?: (next: WorkflowGraph) => void
  /** Fires when the selected node changes; null on deselect. */
  onSelectionChange?: (nodeId: string | null) => void
  /** Imperative patch of a node's data (from the inspector). */
  registerNodePatcher?: (
    patch: (nodeId: string, next: WorkflowNode) => void,
  ) => void
  /** Imperative full-graph replace (undo/redo). */
  registerApplyGraph?: (apply: (graph: WorkflowGraph) => void) => void
  /** Imperative select + centre a node (e.g. clicking an issue). */
  registerSelectNode?: (select: (nodeId: string) => void) => void
}

export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  )
}

function CanvasInner({
  graph,
  readOnly = false,
  defaults,
  invalidNodeIds,
  nodeStatuses,
  onChange,
  onSelectionChange,
  registerNodePatcher,
  registerApplyGraph,
  registerSelectNode,
}: WorkflowCanvasProps) {
  const { Button } = useWfComponents()
  const initial = useMemo(() => engineToFlow(graph), [graph])
  const [nodes, setNodes, onNodesChange] = useNodesState<EditorNode>(
    initial.nodes,
  )
  const [edges, setEdges, onEdgesChange] = useEdgesState<EditorEdge>(
    initial.edges,
  )
  const {
    screenToFlowPosition,
    fitView,
    getIntersectingNodes,
    getInternalNode,
  } = useReactFlow()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const lastEmittedFingerprintRef = useRef<string | null>(null)

  // Re-seed when the upstream graph CONTENT changes (discard draft, sibling tab
  // published). Fingerprint compare avoids clobbering local edits on every
  // parent re-render.
  const lastSeededFingerprintRef = useRef(JSON.stringify(graph))
  useEffect(() => {
    const fingerprint = JSON.stringify(graph)
    if (lastSeededFingerprintRef.current === fingerprint) return
    lastSeededFingerprintRef.current = fingerprint
    const next = engineToFlow(graph)
    lastEmittedFingerprintRef.current = JSON.stringify(
      flowToEngine(next.nodes, next.edges),
    )
    setNodes(next.nodes)
    setEdges(next.edges)
  }, [graph, setNodes, setEdges])

  useEffect(() => {
    if (!registerNodePatcher) return
    registerNodePatcher((nodeId, next) => {
      setNodes((ns) =>
        ns.map((n) =>
          n.id === nodeId ? { ...n, data: extractEditorData(next) } : n,
        ),
      )
    })
  }, [registerNodePatcher, setNodes])

  useEffect(() => {
    if (!registerApplyGraph) return
    registerApplyGraph((next) => {
      const flow = engineToFlow(next)
      setNodes(flow.nodes)
      setEdges(flow.edges)
    })
  }, [registerApplyGraph, setNodes, setEdges])

  useEffect(() => {
    if (!registerSelectNode) return
    registerSelectNode((nodeId) => {
      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === nodeId })))
      fitView({ nodes: [{ id: nodeId }], duration: 400, maxZoom: 1.2 })
    })
  }, [registerSelectNode, setNodes, fitView])

  // onChange is a notification, not a save. Fingerprint-based so cosmetic
  // xyflow re-emits (selection/hover/mid-drag) don't fire structural changes.
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])
  useEffect(() => {
    const fingerprint = JSON.stringify(flowToEngine(nodes, edges))
    if (lastEmittedFingerprintRef.current === null) {
      lastEmittedFingerprintRef.current = fingerprint
      return
    }
    if (lastEmittedFingerprintRef.current === fingerprint) return
    lastEmittedFingerprintRef.current = fingerprint
    onChangeRef.current?.(flowToEngine(nodes, edges))
  }, [nodes, edges])

  const handleConnect = useCallback(
    (params: Connection) => {
      setEdges((eds) => addEdge({ ...params, id: crypto.randomUUID() }, eds))
    },
    [setEdges],
  )

  const handleTidyLayout = useCallback(() => {
    const positions = layoutNodes(nodes, edges)
    setNodes((ns) =>
      ns.map((n) => {
        const next = positions.get(n.id)
        return next ? { ...n, position: next } : n
      }),
    )
    requestAnimationFrame(() => fitView({ duration: 300, padding: 0.2 }))
  }, [nodes, edges, setNodes, fitView])

  const handleSelectionChange = useCallback(
    ({ nodes: sel }: { nodes: EditorNode[] }) => {
      onSelectionChange?.(sel[0]?.id ?? null)
    },
    [onSelectionChange],
  )

  // Membership by containment: when a node is dropped over an iteration
  // container it becomes that container's child (part of the loop); dragged back
  // out onto the canvas it rejoins the top level. Containers don't nest, and the
  // fixed `Item`/`Result` bookends never leave their container.
  const handleNodeDragStop = useCallback(
    (_: unknown, dragged: EditorNode) => {
      // Notes are free-floating annotations; never fold one into a loop container.
      if (dragged.data.kind === 'iteration' || dragged.data.kind === 'note')
        return
      const absPos =
        getInternalNode(dragged.id)?.internals.positionAbsolute ??
        dragged.position
      const container = getIntersectingNodes(dragged).find(
        (n) => (n.data as EditorNodeData).kind === 'iteration',
      )
      const currentParent = dragged.parentId
      if (container && container.id !== currentParent) {
        const cAbs =
          getInternalNode(container.id)?.internals.positionAbsolute ??
          container.position
        const rel = { x: absPos.x - cAbs.x, y: absPos.y - cAbs.y }
        setNodes((ns) =>
          orderParentsFirst(
            ns.map((n) =>
              n.id === dragged.id
                ? { ...n, parentId: container.id, position: rel }
                : n,
            ),
          ),
        )
      } else if (!container && currentParent) {
        // Bookends stay put; only real work nodes can leave the loop.
        if (BOOKEND_KINDS.has(dragged.data.kind)) return
        setNodes((ns) =>
          ns.map((n) =>
            n.id === dragged.id
              ? { ...n, parentId: undefined, position: absPos }
              : n,
          ),
        )
      }
    },
    [getIntersectingNodes, getInternalNode, setNodes],
  )

  // Only connect nodes in the same scope: both top-level, or both inside the
  // same iteration container. This keeps the loop boundary edge-tight (the list
  // feeds the container; the `Item`/`Result` bookends carry data across).
  const isValidConnection = useCallback(
    (conn: Connection | EditorEdge) => {
      const s = nodes.find((n) => n.id === conn.source)
      const t = nodes.find((n) => n.id === conn.target)
      if (!s || !t) return false
      return (s.parentId ?? null) === (t.parentId ?? null)
    },
    [nodes],
  )

  const handleNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      if (readOnly) {
        const selectOnly = changes.filter((c) => c.type === 'select')
        if (selectOnly.length > 0) onNodesChange(selectOnly)
        return
      }
      // Bookends (main trigger/output AND every iteration's Item/Result) can't be
      // deleted directly.
      const bookendIds = new Set(
        nodes.filter((n) => BOOKEND_KINDS.has(n.data.kind)).map((n) => n.id),
      )
      // Deleting an iteration container takes its children with it.
      const removedContainers = new Set(
        changes
          .filter(
            (c) =>
              c.type === 'remove' &&
              nodes.find((n) => n.id === c.id)?.data.kind === 'iteration',
          )
          .map((c) => (c as { id: string }).id),
      )
      const filtered = changes.filter(
        (c) => !(c.type === 'remove' && bookendIds.has(c.id)),
      )
      const childRemovals =
        removedContainers.size === 0
          ? []
          : nodes
              .filter((n) => n.parentId && removedContainers.has(n.parentId))
              .map((n) => ({ type: 'remove' as const, id: n.id }))
      onNodesChange([...filtered, ...childRemovals])
    },
    [readOnly, onNodesChange, nodes],
  )

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

  return (
    <div ref={wrapperRef} className="relative h-full w-full">
      <RunStatusProvider statuses={nodeStatuses ?? EMPTY_STATUSES}>
        <InvalidNodesProvider ids={invalidNodeIds ?? EMPTY_INVALID}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={handleNodesChange}
            onEdgesChange={readOnly ? undefined : onEdgesChange}
            onConnect={readOnly ? undefined : handleConnect}
            onSelectionChange={handleSelectionChange}
            onNodeDragStop={readOnly ? undefined : handleNodeDragStop}
            isValidConnection={isValidConnection}
            nodeTypes={NODE_TYPES}
            // Keep iteration children clickable: without this, selecting the
            // container elevates it above its own children so their clicks never
            // land. Children already sit above the container by array order.
            elevateNodesOnSelect={false}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            onDrop={readOnly ? undefined : handleDrop}
            onDragOver={readOnly ? undefined : handleDragOver}
            defaultEdgeOptions={{
              type: 'smoothstep',
              markerEnd: { type: MarkerType.ArrowClosed },
            }}
            fitView
            // Frame the whole workflow on open instead of zooming right in:
            // React Flow's default maxZoom is 2, which blows small graphs up to
            // fill the viewport. Cap at 1 so the entire graph stays visible.
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} />
            <Controls />
            {!readOnly ? (
              <Panel
                position="top-left"
                className="rounded-md bg-white shadow-sm"
              >
                <Tooltip
                  content="Auto-arrange nodes into a tidy left-to-right layout"
                  side="right"
                >
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleTidyLayout}
                  >
                    <LayoutGrid className="size-4" />
                    Tidy
                  </Button>
                </Tooltip>
              </Panel>
            ) : null}
            <MiniMap pannable zoomable />
            <Panel
              position="top-right"
              className="bg-card text-muted-foreground rounded-md border px-2 py-1 text-[11px]"
            >
              {nodes.length} nodes · {edges.length} edges
            </Panel>
          </ReactFlow>
        </InvalidNodesProvider>
      </RunStatusProvider>
    </div>
  )
}
