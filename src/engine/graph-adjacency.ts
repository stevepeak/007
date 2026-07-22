import type { WorkflowEdge, WorkflowGraph } from './graph'

// The incoming/outgoing edge adjacency of a graph, built in one O(E) sweep and
// shared by every walk that needs it (the runtime scheduler, the join/cone
// topology analysis, and the author-time traversal helpers). `incoming` is keyed
// by an edge's target node id, `outgoing` by its source; each value is the list
// of edges in graph declaration order (the array-insertion order callers rely on
// for deterministic, replay-safe tie-breaks). A node with no edges on a given
// side simply has no entry there — read with `.get(id) ?? []`. Type-only import
// of graph.ts keeps this a leaf module with no import cycle.
export type Adjacency = {
  /** Incoming edges keyed by target node id. */
  incoming: Map<string, WorkflowEdge[]>
  /** Outgoing edges keyed by source node id. */
  outgoing: Map<string, WorkflowEdge[]>
}

export function buildAdjacency(graph: WorkflowGraph): Adjacency {
  const incoming = new Map<string, WorkflowEdge[]>()
  const outgoing = new Map<string, WorkflowEdge[]>()
  for (const e of graph.edges) {
    const inc = incoming.get(e.target)
    if (inc) inc.push(e)
    else incoming.set(e.target, [e])
    const out = outgoing.get(e.source)
    if (out) out.push(e)
    else outgoing.set(e.source, [e])
  }
  return { incoming, outgoing }
}
