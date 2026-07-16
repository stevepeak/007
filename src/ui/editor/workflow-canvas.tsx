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
  type Edge,
  type Node,
} from '@xyflow/react'
import Dagre from '@dagrejs/dagre'
import { LayoutGrid } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type DragEvent as ReactDragEvent,
} from 'react'

import {
  buildIterationSubgraph,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
} from '../../engine'
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

type EditorNode = Node<EditorNodeData>
type EditorEdge = Edge

// Trigger + output are the workflow's bookends — exactly one trigger and at
// least one output are required and there's no palette entry to re-add one, so
// they're non-deletable end to end. The same kinds serve as an iteration
// container's `Item` (trigger) and `Result` (output) bookends, likewise fixed.
const BOOKEND_KINDS = new Set(['trigger', 'output'])

// Default size of a freshly-dropped iteration container (px). Persisted per node
// on `config.width/height` once resized.
const DEFAULT_ITER_W = 480
const DEFAULT_ITER_H = 240

// Default size of a freshly-dropped sticky Note (px). Persisted per node on
// `config.width/height` once resized.
const DEFAULT_NOTE_W = 240
const DEFAULT_NOTE_H = 160

/** Defaults for freshly-dragged nodes — sourced from the host's models/tools. */
export type NodeDefaults = { toolId: string }

// Stable empty set so the provider value doesn't change identity each render
// when no invalid ids are passed.
const EMPTY_INVALID: ReadonlySet<string> = new Set()

// Stable empty map so the run-status provider keeps identity in the editor.
const EMPTY_STATUSES: ReadonlyMap<string, string> = new Map()

function edgeToFlow(e: WorkflowEdge): EditorEdge {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.condition ?? undefined,
    label: e.condition ?? undefined,
    data: { condition: e.condition },
  }
}

// An iteration node is a *container*: its `subgraph` nodes are flattened onto the
// same canvas as React Flow children (`parentId` = the container) so authors drag
// work between the `Item` (trigger) and `Result` (output) bookends. The subgraph
// edges become edges among those children. `flowToEngine` reverses this. React
// Flow requires a parent to appear before its children in the array, which this
// order (container, then its children) satisfies.
function engineToFlow(graph: WorkflowGraph): {
  nodes: EditorNode[]
  edges: EditorEdge[]
} {
  const nodes: EditorNode[] = []
  const edges: EditorEdge[] = []
  for (const n of graph.nodes) {
    if (n.kind === 'iteration') {
      nodes.push({
        id: n.id,
        type: editorTypeForKind('iteration'),
        position: n.position,
        deletable: true,
        data: extractEditorData(n),
        style: {
          width: n.config.width ?? DEFAULT_ITER_W,
          height: n.config.height ?? DEFAULT_ITER_H,
        },
      })
      for (const child of n.config.subgraph.nodes) {
        nodes.push({
          id: child.id,
          type: editorTypeForKind(child.kind),
          position: child.position,
          parentId: n.id,
          deletable: !BOOKEND_KINDS.has(child.kind),
          data: extractEditorData(child),
        })
      }
      for (const e of n.config.subgraph.edges) edges.push(edgeToFlow(e))
    } else if (n.kind === 'note') {
      // A resizable sticky note — its size lives on config.width/height so it
      // round-trips; NodeResizer reads it off the node style.
      nodes.push({
        id: n.id,
        type: editorTypeForKind('note'),
        position: n.position,
        deletable: true,
        data: extractEditorData(n),
        style: {
          width: n.config.width ?? DEFAULT_NOTE_W,
          height: n.config.height ?? DEFAULT_NOTE_H,
        },
      })
    } else {
      nodes.push({
        id: n.id,
        type: editorTypeForKind(n.kind),
        position: n.position,
        deletable: !BOOKEND_KINDS.has(n.kind),
        data: extractEditorData(n),
      })
    }
  }
  for (const e of graph.edges) edges.push(edgeToFlow(e))
  return { nodes, edges }
}

function extractEditorData(n: WorkflowNode): EditorNodeData {
  return { kind: n.kind, label: n.label, config: n.config } as EditorNodeData
}

function edgeToEngine(e: EditorEdge): WorkflowEdge {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    // The source handle id IS the edge condition — 'yes'/'no' for a binary
    // decision, a case key or 'default' for a switch. Non-decision edges have no
    // handle id, so this is null.
    condition: e.sourceHandle ?? null,
  }
}

function engineNodeOf(n: EditorNode): WorkflowNode {
  return {
    id: n.id,
    position: { x: n.position.x, y: n.position.y },
    ...n.data,
  } as WorkflowNode
}

// Reverse of engineToFlow: re-nest each iteration container's children back into
// its `config.subgraph`. Top-level nodes form the main graph; a node's children
// (by `parentId`) plus the edges wholly inside that container become its subgraph.
function flowToEngine(nodes: EditorNode[], edges: EditorEdge[]): WorkflowGraph {
  const parentOf = new Map(nodes.map((n) => [n.id, n.parentId]))
  const childrenByParent = new Map<string, EditorNode[]>()
  const topLevel: EditorNode[] = []
  for (const n of nodes) {
    if (n.parentId) {
      const list = childrenByParent.get(n.parentId)
      if (list) list.push(n)
      else childrenByParent.set(n.parentId, [n])
    } else {
      topLevel.push(n)
    }
  }

  const mainEdges: WorkflowEdge[] = []
  const subEdges = new Map<string, WorkflowEdge[]>()
  for (const e of edges) {
    const ps = parentOf.get(e.source)
    const pt = parentOf.get(e.target)
    if (!ps && !pt) {
      mainEdges.push(edgeToEngine(e))
    } else if (ps && ps === pt) {
      const list = subEdges.get(ps)
      if (list) list.push(edgeToEngine(e))
      else subEdges.set(ps, [edgeToEngine(e)])
    }
    // Cross-boundary edges are prevented by isValidConnection; ignore any stray.
  }

  const engineNodes: WorkflowNode[] = topLevel.map((n) => {
    const data = n.data
    if (data.kind !== 'iteration') return engineNodeOf(n)
    const kids = childrenByParent.get(n.id) ?? []
    return {
      id: n.id,
      position: { x: n.position.x, y: n.position.y },
      kind: 'iteration',
      label: data.label,
      config: {
        ...data.config,
        subgraph: {
          version: 1,
          nodes: kids.map(engineNodeOf),
          edges: subEdges.get(n.id) ?? [],
        },
      },
    }
  })

  return { version: 1, nodes: engineNodes, edges: mainEdges }
}

// React Flow requires each parent node to precede its children in the array.
// After a reparent we re-emit nodes parent-first (one level deep here).
function orderParentsFirst(nodes: EditorNode[]): EditorNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const seen = new Set<string>()
  const out: EditorNode[] = []
  const emit = (n: EditorNode) => {
    if (seen.has(n.id)) return
    if (n.parentId) {
      const p = byId.get(n.parentId)
      if (p) emit(p)
    }
    seen.add(n.id)
    out.push(n)
  }
  for (const n of nodes) emit(n)
  return out
}

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

// Layered left-to-right auto-layout ("Tidy layout"). The graph is a near-DAG
// (trigger → … → output). We delegate to dagre's Sugiyama pipeline (rank →
// iterated crossing-minimisation → coordinate assignment), which produces far
// fewer wire crossings than a single-pass barycenter sort and, because it lays
// out from each node's real measured size, never overlaps tall nodes.
//
// `ranksep` is the horizontal gap between layers; `nodesep` the vertical gap
// between stacked nodes. Fallback dimensions cover nodes React hasn't measured
// yet (node cards are 200–260px wide, ~variable height).
const LAYOUT_RANK_SEP = 120
const LAYOUT_NODE_SEP = 56
const LAYOUT_DEFAULT_W = 240
const LAYOUT_DEFAULT_H = 120

function layoutNodes(
  nodes: EditorNode[],
  edges: EditorEdge[],
): Map<string, { x: number; y: number }> {
  const g = new Dagre.graphlib.Graph({ multigraph: true })
  g.setGraph({
    rankdir: 'LR',
    ranksep: LAYOUT_RANK_SEP,
    nodesep: LAYOUT_NODE_SEP,
    // A conditional branch is a cycle if a `no` arm loops back; break cycles
    // greedily so layout still succeeds instead of throwing.
    acyclicer: 'greedy',
  })
  g.setDefaultEdgeLabel(() => ({}))

  const dims = new Map<string, { width: number; height: number }>()
  for (const n of nodes) {
    const width = n.measured?.width ?? n.width ?? LAYOUT_DEFAULT_W
    const height = n.measured?.height ?? n.height ?? LAYOUT_DEFAULT_H
    dims.set(n.id, { width, height })
    g.setNode(n.id, { width, height })
  }
  // dagre seeds its within-rank order from a DFS that follows edge-insertion
  // order, and only flips a pair when that *strictly* reduces crossings — which
  // a symmetric branch never does. So inserting `yes` arms before `no` arms
  // pins `yes` above `no` out of every branch node. (Stable sort keeps the
  // original order among same-priority edges.)
  const handlePriority = (h: EditorEdge['sourceHandle']) =>
    h === 'yes' ? 0 : h === 'no' ? 1 : 2
  const ordered = [...edges].sort(
    (a, b) => handlePriority(a.sourceHandle) - handlePriority(b.sourceHandle),
  )
  for (const e of ordered) {
    if (!dims.has(e.source) || !dims.has(e.target)) continue
    g.setEdge(e.source, e.target, { weight: 1 }, e.sourceHandle ?? undefined)
  }

  Dagre.layout(g)

  // dagre positions nodes by their centre; React Flow positions by top-left.
  const positions = new Map<string, { x: number; y: number }>()
  for (const n of nodes) {
    const p = g.node(n.id)
    const d = dims.get(n.id)
    if (!p || !d) continue
    positions.set(n.id, { x: p.x - d.width / 2, y: p.y - d.height / 2 })
  }
  return positions
}

// Default data for a freshly-dragged palette item. Model/tool ids come from the
// host (first available), so no provider is hardcoded. Returns null for the
// bookend kinds (trigger/output are template-owned, not palette-added).
function defaultDataForKind(
  kind: string,
  defaults?: NodeDefaults,
): EditorNodeData | null {
  const toolId = defaults?.toolId || 'tool'
  if (kind === 'agent') {
    // A pointer node — the inspector picks which pre-developed agent to run.
    return {
      kind: 'agent',
      label: 'New agent',
      config: { agentId: '', version: null, inputs: {}, imageInputs: {} },
    }
  }
  if (kind === 'tool') {
    return { kind: 'tool', label: 'New tool', config: { toolId, args: {} } }
  }
  if (kind === 'branch') {
    return {
      kind: 'branch',
      label: 'New branch',
      config: { operator: 'is_not_empty' },
    }
  }
  if (kind === 'switch') {
    // Seeded with no cases — the author adds them in the inspector, which grows
    // one outgoing handle per case plus the always-present `default`. Until a
    // 'default' edge exists the graph flags a (non-blocking) issue.
    return {
      kind: 'switch',
      label: 'New switch',
      config: { path: '', cases: [] },
    }
  }
  if (kind === 'iteration') {
    // Seeded with a minimal Item → Result subgraph; the author drops work nodes
    // into the block. `itemsPath` is intentionally left unset so the block reads
    // as "no list selected" (an error) until the author picks one.
    return {
      kind: 'iteration',
      label: 'New iteration',
      config: {
        concurrency: 4,
        stopOnError: false,
        subgraph: buildIterationSubgraph(),
      },
    }
  }
  if (kind === 'workflow') {
    // A pointer node — the inspector picks which workflow to call. Left empty so
    // it reads as "no workflow selected" (an error) until the author picks one.
    return {
      kind: 'workflow',
      label: 'Call workflow',
      config: { workflowId: '', inputs: {} },
    }
  }
  if (kind === 'feature-request') {
    return {
      kind: 'feature-request',
      label: 'Feature request',
      config: { description: '' },
    }
  }
  if (kind === 'race') {
    // A config-less first-to-finish join. The author wires several upstreams into
    // it; the first to complete wins. It reads as a (non-blocking) "needs 2+
    // inputs" warning until at least two feed in.
    return { kind: 'race', label: 'Race', config: {} }
  }
  if (kind === 'aggregate') {
    // A config-less wait-for-all join. The author wires several upstreams into it;
    // once all complete it emits an ordered list (one element per producer) for a
    // downstream sibling to iterate. Reads as a (non-blocking) "needs 2+ inputs"
    // warning until at least two feed in.
    return { kind: 'aggregate', label: 'Aggregate', config: {} }
  }
  if (kind === 'note') {
    return { kind: 'note', label: 'Note', config: { text: '' } }
  }
  return null
}
