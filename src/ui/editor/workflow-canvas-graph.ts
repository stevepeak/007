import { type Edge, type Node } from '@xyflow/react'

import {
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
} from '../../engine'
import { editorTypeForKind, type EditorNodeData } from './node-renderers'

export type EditorNode = Node<EditorNodeData>
export type EditorEdge = Edge

// Trigger + output are the workflow's bookends — exactly one trigger and at
// least one output are required and there's no palette entry to re-add one, so
// they're non-deletable end to end. The same kinds serve as an iteration
// container's `Item` (trigger) and `Result` (output) bookends, likewise fixed.
export const BOOKEND_KINDS = new Set(['trigger', 'output'])

// Default size of a freshly-dropped iteration container (px). Persisted per node
// on `config.width/height` once resized.
export const DEFAULT_ITER_W = 480
export const DEFAULT_ITER_H = 240

// Default size of a freshly-dropped sticky Note (px). Persisted per node on
// `config.width/height` once resized.
export const DEFAULT_NOTE_W = 240
export const DEFAULT_NOTE_H = 160

export function edgeToFlow(e: WorkflowEdge): EditorEdge {
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
export function engineToFlow(graph: WorkflowGraph): {
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

export function extractEditorData(n: WorkflowNode): EditorNodeData {
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
export function flowToEngine(nodes: EditorNode[], edges: EditorEdge[]): WorkflowGraph {
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
export function orderParentsFirst(nodes: EditorNode[]): EditorNode[] {
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
