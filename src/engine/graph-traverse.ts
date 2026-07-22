import type { WorkflowGraph } from './graph'
import { buildAdjacency } from './graph-adjacency'

// Author-time graph traversal. Unlike the runtime scheduler (which only walks
// *alive* edges once branch decisions are known), these helpers answer the
// structural question "which nodes could feed this one?" — every possible
// upstream producer is visible so the editor can offer them for data mapping.

// Direct predecessors of a node (nodes with an edge straight into it).
export function predecessorIds(graph: WorkflowGraph, nodeId: string): string[] {
  return (buildAdjacency(graph).incoming.get(nodeId) ?? []).map((e) => e.source)
}

// All node ids with a directed path into `nodeId`, nearest-first (BFS over
// reversed edges). Cycles are impossible in a valid graph, but the `seen` guard
// keeps this safe regardless.
export function ancestorIds(graph: WorkflowGraph, nodeId: string): string[] {
  const { incoming } = buildAdjacency(graph)
  const seen = new Set<string>()
  const order: string[] = []
  let frontier = (incoming.get(nodeId) ?? []).map((e) => e.source)
  while (frontier.length > 0) {
    const next: string[] = []
    for (const id of frontier) {
      if (seen.has(id)) continue
      seen.add(id)
      order.push(id)
      next.push(...(incoming.get(id) ?? []).map((e) => e.source))
    }
    frontier = next
  }
  return order
}
