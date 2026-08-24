import { useState } from 'react'

import type { WorkflowGraph, WorkflowNode } from '../../engine'
import { useUndoStack, type CoalesceRule } from '../undo/use-undo-stack'

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
  return kind.replaceAll('-', ' ')
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

// What the stack actually holds. `EditSnapshot` is this plus its label, kept as
// its own exported type because the History dropdown renders those rows.
type Snapshot = { graph: WorkflowGraph; name: string }

// A drag emits a change per tick and a text field emits one per keystroke; both
// are ONE edit to a reader. `describeChange` already names the node it touched,
// so the label is a good enough identity for "still the same gesture".
//
// Moves have no window — a drag ends when the pointer does. Typing gets 600ms,
// so a pause starts a new entry and undo lands where you'd expect.
function coalesceGraphEdit(
  _prev: Snapshot,
  _next: Snapshot,
  label: string,
): CoalesceRule {
  if (label.startsWith('Moved')) return { key: label }
  if (label.startsWith('Edited') || label.startsWith('Renamed node')) {
    return { key: label, windowMs: 600 }
  }
  return null
}

// The workflow editor's view of the shared undo engine: the graph and title
// under edit, plus the canvas restore channel. Everything about stacks, dirty
// tracking and keyboard routing lives in `useUndoStack`; what stays here is the
// pair of facts specific to a workflow — that a snapshot is a graph AND a name,
// and that the canvas has to be told when one is re-applied.
export function useEditHistory(
  initialGraph: WorkflowGraph,
  initialName: string,
  applyGraphToCanvas: (graph: WorkflowGraph) => void,
  // The title is the one field that is BOTH undoable and written to the server
  // the moment it's committed. Without telling the caller when a snapshot moves
  // it, undoing a rename would show the old title while the server kept the new
  // one — so the caller re-commits, and what you see stays what is stored.
  onNameRestored?: (name: string) => void,
) {
  const [name, setName] = useState(initialName)

  const history = useUndoStack<Snapshot>({
    initial: { graph: initialGraph, name: initialName },
    max: MAX_HISTORY,
    describe: (prev, next) => describeChange(prev.graph, next.graph),
    coalesce: coalesceGraphEdit,
    onApply: (snap) => {
      applyGraphToCanvas(snap.graph)
      setName(snap.name)
      onNameRestored?.(snap.name)
    },
  })

  const { graph } = history.state

  // The canvas emits its whole graph on every change; the title lives outside it.
  function recordCanvasChange(next: WorkflowGraph) {
    history.record({ graph: next, name })
  }

  /** Push an explicit entry — a rename, which no graph diff would describe. */
  function push(snap: EditSnapshot) {
    history.push({ state: { graph: snap.graph, name: snap.name }, label: snap.label })
  }

  // Load a graph as a fresh, undoable history entry (version load / restore).
  // Omitting `name` keeps the current title; passing it renames alongside.
  function loadSnapshot(snap: {
    graph: WorkflowGraph
    name?: string
    label: string
  }) {
    history.load({
      state: { graph: snap.graph, name: snap.name ?? name },
      label: snap.label,
    })
  }

  return {
    graph,
    name,
    setName,
    // Flattened back to the `{ graph, name, label }` rows the History dropdown
    // renders. The stack stores state and label separately; this surface predates
    // that split and there is no reason to churn its callers over it.
    snapshots: history.entries.map((e) => ({ ...e.state, label: e.label })),
    index: history.index,
    dirty: history.dirty,
    push,
    recordCanvasChange,
    applySnapshot: history.applyIndex,
    loadSnapshot,
    undo: history.undo,
    redo: history.redo,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    undoLabel: history.undoLabel,
    redoLabel: history.redoLabel,
    markSaved: history.markSaved,
  }
}
