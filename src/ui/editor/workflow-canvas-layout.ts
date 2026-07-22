import Dagre from '@dagrejs/dagre'

import { type EditorEdge, type EditorNode } from './workflow-canvas-graph'

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

export function layoutNodes(
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
