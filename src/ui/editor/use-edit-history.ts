import { useEffect, useRef, useState } from 'react'

import type { WorkflowGraph, WorkflowNode } from '../../engine'

// One entry in the undo/redo change history. The workflow name lives here too
// (not in the graph), so renaming the title is undoable alongside graph edits.
// `label` is a short human description of what the change did.
export type EditSnapshot = { graph: WorkflowGraph; name: string; label: string }

// Longest node name we inline into a history message before ellipsizing, so the
// History dropdown rows (already `truncate`d) stay tidy.
const MAX_NAME_LEN = 32

// Cap on retained snapshots. Past this we forget the oldest and keep the last
// MAX_HISTORY (the seeded "Opened" entry is trimmed once enough edits pile up).
const MAX_HISTORY = 50

// A node's display name, quoted and length-capped, for a history message.
function nodeName(node: WorkflowNode): string {
  const label = node.label.trim()
  const short =
    label.length > MAX_NAME_LEN ? `${label.slice(0, MAX_NAME_LEN - 1)}…` : label
  return `"${short}"`
}

// Human-friendly node kind (the schema uses a few hyphenated kinds).
function kindLabel(kind: string): string {
  return kind.replace(/-/g, ' ')
}

// Best-effort short description of a graph edit, for the change-history log.
// Uses each node's human name and a specific verb so a reader can tell what
// happened without opening the node. Exported for unit testing.
export function describeChange(prev: WorkflowGraph, next: WorkflowGraph): string {
  const prevNodes = new Map(prev.nodes.map((n) => [n.id, n]))
  const nextNodes = new Map(next.nodes.map((n) => [n.id, n]))

  // Adds — one node names it; several collapse to a count.
  const added = [...nextNodes.values()].filter((n) => !prevNodes.has(n.id))
  if (added.length === 1) {
    return `Added ${nodeName(added[0])} ${kindLabel(added[0].kind)}`
  }
  if (added.length > 1) return `Added ${added.length} nodes`

  // Removes — same shape as adds.
  const removed = [...prevNodes.values()].filter((n) => !nextNodes.has(n.id))
  if (removed.length === 1) {
    return `Removed ${nodeName(removed[0])} ${kindLabel(removed[0].kind)}`
  }
  if (removed.length > 1) return `Removed ${removed.length} nodes`

  // Edge changes — name the endpoints of the one edge that changed when we can.
  if (next.edges.length > prev.edges.length) {
    const prevIds = new Set(prev.edges.map((e) => e.id))
    const addedEdge = next.edges.find((e) => !prevIds.has(e.id))
    const from = addedEdge && nextNodes.get(addedEdge.source)
    const to = addedEdge && nextNodes.get(addedEdge.target)
    if (from && to) return `Connected ${nodeName(from)} → ${nodeName(to)}`
    return 'Connected nodes'
  }
  if (next.edges.length < prev.edges.length) {
    const nextIds = new Set(next.edges.map((e) => e.id))
    const goneEdge = prev.edges.find((e) => !nextIds.has(e.id))
    const from = goneEdge && prevNodes.get(goneEdge.source)
    const to = goneEdge && prevNodes.get(goneEdge.target)
    if (from && to) {
      return `Removed connection ${nodeName(from)} → ${nodeName(to)}`
    }
    return 'Removed connection'
  }

  // In-place node changes: rename (label only), settings (config), or move.
  let moved: WorkflowNode | null = null
  for (const [id, nn] of nextNodes) {
    const pn = prevNodes.get(id)
    if (!pn) continue
    if (pn.label !== nn.label) return `Renamed node to ${nodeName(nn)}`
    if (JSON.stringify(pn.config) !== JSON.stringify(nn.config)) {
      return `Edited ${nodeName(nn)} settings`
    }
    if (pn.position.x !== nn.position.x || pn.position.y !== nn.position.y) {
      moved = nn
    }
  }
  if (moved) return `Moved ${nodeName(moved)}`
  return 'Edited workflow'
}

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return (
    !!el &&
    (el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.isContentEditable)
  )
}

// Owns the editor's undo/redo history engine: the `graph`/`name` under edit, the
// snapshot stack, dirty tracking, and the global keyboard undo/redo handler.
// `applyGraphToCanvas` re-applies a snapshot's graph to the xyflow canvas (the
// imperative ref lives in the editor); the hook stays out of the canvas ref
// protocol otherwise.
export function useEditHistory(
  initialGraph: WorkflowGraph,
  initialName: string,
  applyGraphToCanvas: (graph: WorkflowGraph) => void,
) {
  const [graph, setGraph] = useState<WorkflowGraph>(initialGraph)
  const [name, setName] = useState(initialName)

  // Undo/redo history. `applyingRef` suppresses recording the change the canvas
  // re-emits when we programmatically apply a snapshot (undo/redo/version load).
  const historyRef = useRef<EditSnapshot[]>([
    { graph: initialGraph, name: initialName, label: 'Opened' },
  ])
  const indexRef = useRef(0)
  const applyingRef = useRef(false)
  // Which history index reflects the last-saved state (drives the dirty flag).
  const [savedIndex, setSavedIndex] = useState(0)
  // Bumped on any history mutation so the toolbar re-renders (refs alone don't).
  const [, forceRender] = useState(0)
  const bump = () => forceRender((n) => n + 1)

  // Push a new snapshot onto the history stack, truncating any redo tail and
  // forgetting the oldest entries once the stack exceeds MAX_HISTORY.
  function push(snap: EditSnapshot) {
    const trimmed = historyRef.current.slice(0, indexRef.current + 1)
    trimmed.push(snap)
    let dropped = 0
    if (trimmed.length > MAX_HISTORY) {
      dropped = trimmed.length - MAX_HISTORY
      trimmed.splice(0, dropped)
    }
    historyRef.current = trimmed
    indexRef.current = trimmed.length - 1
    // Dropping from the front shifts every absolute index down. Keep savedIndex
    // pointed at the saved snapshot; if it fell off the front it goes negative
    // and can never re-equal `index`, so `dirty` correctly stays true.
    if (dropped) setSavedIndex((s) => s - dropped)
    bump()
  }

  function recordCanvasChange(next: WorkflowGraph) {
    setGraph(next)
    if (applyingRef.current) {
      applyingRef.current = false
      return
    }
    const prev = historyRef.current[indexRef.current]
    const label = prev ? describeChange(prev.graph, next) : 'Edited workflow'
    // Coalesce a run of drag emissions into a single "Moved" entry so the
    // change log stays readable (xyflow emits a change per drag tick).
    const atTip = indexRef.current === historyRef.current.length - 1
    if (atTip && label.startsWith('Moved') && prev?.label.startsWith('Moved')) {
      const copy = historyRef.current.slice()
      copy[indexRef.current] = { graph: next, name, label }
      historyRef.current = copy
      return
    }
    push({ graph: next, name, label })
  }

  function applySnapshot(index: number) {
    const snap = historyRef.current[index]
    if (!snap) return
    indexRef.current = index
    applyingRef.current = true
    applyGraphToCanvas(snap.graph)
    setGraph(snap.graph)
    setName(snap.name)
    bump()
  }

  // Load a graph as a fresh, undoable history entry (version load / restore).
  // Omitting `name` keeps the current title; passing it renames alongside.
  function loadSnapshot(snap: {
    graph: WorkflowGraph
    name?: string
    label: string
  }) {
    applyingRef.current = true
    applyGraphToCanvas(snap.graph)
    setGraph(snap.graph)
    if (snap.name !== undefined) setName(snap.name)
    push({ graph: snap.graph, name: snap.name ?? name, label: snap.label })
  }

  function undo() {
    if (indexRef.current > 0) applySnapshot(indexRef.current - 1)
  }
  function redo() {
    if (indexRef.current < historyRef.current.length - 1) {
      applySnapshot(indexRef.current + 1)
    }
  }

  const dirty = indexRef.current !== savedIndex

  // Keyboard undo/redo (the toolbar buttons were removed). Ignore when typing in
  // a field. Cmd/Ctrl+Z = undo, Cmd/Ctrl+Shift+Z or Ctrl+Y = redo.
  const undoRef = useRef(undo)
  const redoRef = useRef(redo)
  undoRef.current = undo
  redoRef.current = redo
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || isEditableTarget(e.target)) return
      const key = e.key.toLowerCase()
      if (key === 'z') {
        e.preventDefault()
        if (e.shiftKey) redoRef.current()
        else undoRef.current()
      } else if (key === 'y') {
        e.preventDefault()
        redoRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return {
    graph,
    name,
    setName,
    snapshots: historyRef.current,
    index: indexRef.current,
    dirty,
    push,
    recordCanvasChange,
    applySnapshot,
    loadSnapshot,
    undo,
    redo,
    // Toolbar affordances: whether a step exists in each direction, and the
    // label of the change it would undo/redo (for the button tooltips).
    canUndo: indexRef.current > 0,
    canRedo: indexRef.current < historyRef.current.length - 1,
    undoLabel: historyRef.current[indexRef.current]?.label,
    redoLabel: historyRef.current[indexRef.current + 1]?.label,
    // Mark the current history index as the last-saved state (clears dirty).
    markSaved: () => setSavedIndex(indexRef.current),
  }
}
