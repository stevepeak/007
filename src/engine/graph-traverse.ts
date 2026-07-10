import type { WorkflowGraph } from './graph'

// Author-time graph traversal. Unlike the runtime scheduler (which only walks
// *alive* edges once branch decisions are known), these helpers answer the
// structural question "which nodes could feed this one?" — every possible
// upstream producer is visible so the editor can offer them for data mapping.

function incomingMap(graph: WorkflowGraph): Map<string, string[]> {
  const incoming = new Map<string, string[]>()
  for (const e of graph.edges) {
    const list = incoming.get(e.target)
    if (list) list.push(e.source)
    else incoming.set(e.target, [e.source])
  }
  return incoming
}

// Direct predecessors of a node (nodes with an edge straight into it).
export function predecessorIds(graph: WorkflowGraph, nodeId: string): string[] {
  return incomingMap(graph).get(nodeId) ?? []
}

// All node ids with a directed path into `nodeId`, nearest-first (BFS over
// reversed edges). Cycles are impossible in a valid graph, but the `seen` guard
// keeps this safe regardless.
export function ancestorIds(graph: WorkflowGraph, nodeId: string): string[] {
  const incoming = incomingMap(graph)
  const seen = new Set<string>()
  const order: string[] = []
  let frontier = incoming.get(nodeId) ?? []
  while (frontier.length > 0) {
    const next: string[] = []
    for (const id of frontier) {
      if (seen.has(id)) continue
      seen.add(id)
      order.push(id)
      next.push(...(incoming.get(id) ?? []))
    }
    frontier = next
  }
  return order
}
