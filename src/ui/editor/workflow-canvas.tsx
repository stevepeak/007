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
import { useCallback, useMemo, useRef } from 'react'

import type { WorkflowGraph, WorkflowNode } from '../../engine'
import { useWfComponents } from '../context'
import { Tooltip } from '../tooltip'

import {
  InvalidNodesProvider,
  NODE_TYPES,
  RunAgentVersionProvider,
  RunStatusProvider,
} from './node-renderers'
import { useCanvasDrop } from './workflow-canvas-drop'
import {
  BOOKEND_KINDS,
  engineToFlow,
  type EditorEdge,
  type EditorNode,
} from './workflow-canvas-graph'
import { layoutNodes } from './workflow-canvas-layout'
import type { NodeDefaults } from './workflow-canvas-palette'
import { useCanvasSync } from './workflow-canvas-sync'

export type { NodeDefaults } from './workflow-canvas-palette'

// The xyflow surface. This file is the RENDER plus the rules that live on
// change events; the plumbing that keeps flow state and the engine graph in
// agreement is in `workflow-canvas-sync`, and everything about iteration
// membership — palette drops, drag-to-join — is in `workflow-canvas-drop`.

// Stable empty set so the provider value doesn't change identity each render
// when no invalid ids are passed.
const EMPTY_INVALID: ReadonlySet<string> = new Set()

// Stable empty map so the run-status provider keeps identity in the editor.
const EMPTY_STATUSES: ReadonlyMap<string, string> = new Map()

// Ditto for the run's frozen agent versions (empty in the editor).
const EMPTY_AGENT_VERSIONS: ReadonlyMap<string, number> = new Map()

export interface WorkflowCanvasProps {
  graph: WorkflowGraph
  readOnly?: boolean
  defaults?: NodeDefaults
  /** Node ids with a blocking issue — highlighted on the canvas. */
  invalidNodeIds?: ReadonlySet<string>
  /** Run-view only: nodeId → run status, tinting nodes + showing status dots. */
  nodeStatuses?: ReadonlyMap<string, string>
  /** Run-view only: nodeId → the agent version that node actually ran (frozen
   *  in the run manifest). Agent cards label themselves with it instead of the
   *  catalog's current latest, which a floating node may since have outgrown. */
  nodeAgentVersions?: ReadonlyMap<string, number>
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
  nodeAgentVersions,
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
  const { fitView } = useReactFlow()
  const wrapperRef = useRef<HTMLDivElement>(null)

  useCanvasSync({
    graph,
    nodes,
    edges,
    setNodes,
    setEdges,
    onChange,
    registerNodePatcher,
    registerApplyGraph,
    registerSelectNode,
  })

  const { handleDragOver, handleDrop, handleNodeDragStop } = useCanvasDrop({
    defaults,
    setNodes,
    setEdges,
  })

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

  return (
    <div ref={wrapperRef} className="relative h-full w-full">
      <RunStatusProvider statuses={nodeStatuses ?? EMPTY_STATUSES}>
        <RunAgentVersionProvider
          versions={nodeAgentVersions ?? EMPTY_AGENT_VERSIONS}
        >
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
        </RunAgentVersionProvider>
      </RunStatusProvider>
    </div>
  )
}
