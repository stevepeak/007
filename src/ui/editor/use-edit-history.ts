import { useEffect, useRef, useState } from 'react'

import type { WorkflowGraph } from '../../engine'

// One entry in the undo/redo change history. The workflow name lives here too
// (not in the graph), so renaming the title is undoable alongside graph edits.
// `label` is a short human description of what the change did.
export type EditSnapshot = { graph: WorkflowGraph; name: string; label: string }

// Best-effort short description of a graph edit, for the change-history log.
function describeChange(prev: WorkflowGraph, next: WorkflowGraph): string {
  const prevNodes = new Map(prev.nodes.map((n) => [n.id, n]))
  const nextNodes = new Map(next.nodes.map((n) => [n.id, n]))
  for (const [id, n] of nextNodes) {
    if (!prevNodes.has(id)) return `Added ${n.kind} node`
  }
  for (const [id, n] of prevNodes) {
    if (!nextNodes.has(id)) return `Removed ${n.kind} node`
  }
  if (next.edges.length > prev.edges.length) return 'Connected nodes'
  if (next.edges.length < prev.edges.length) return 'Removed connection'
  let movedKind: string | null = null
  for (const [id, nn] of nextNodes) {
    const pn = prevNodes.get(id)
    if (!pn) continue
    const dataChanged =
      JSON.stringify({ label: pn.label, config: pn.config }) !==
      JSON.stringify({ label: nn.label, config: nn.config })
    if (dataChanged) return `Edited ${nn.kind} node`
    if (pn.position.x !== nn.position.x || pn.position.y !== nn.position.y) {
      movedKind = nn.kind
    }
  }
  if (movedKind) return `Moved ${movedKind} node`
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

  // Push a new snapshot onto the history stack, truncating any redo tail.
  function push(snap: EditSnapshot) {
    const trimmed = historyRef.current.slice(0, indexRef.current + 1)
    trimmed.push(snap)
    historyRef.current = trimmed
    indexRef.current = trimmed.length - 1
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
    // Mark the current history index as the last-saved state (clears dirty).
    markSaved: () => setSavedIndex(indexRef.current),
  }
}
