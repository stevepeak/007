import type { WorkflowGraph, WorkflowNode } from './graph-schema'

// Structural walks over a graph, iteration subgraphs included. An iteration's
// subgraph runs inline once per item against the same run manifest, so any
// question about "the nodes of this graph" — which agents it names, which
// tools it calls, where a node lives — has to look inside it too, and the
// nodes inside are the ones an author is least likely to re-open.

/** Every node, depth-first, iteration subgraphs included. */
export function* allNodes(graph: WorkflowGraph): Generator<WorkflowNode> {
  for (const node of graph.nodes) {
    yield node
    if (node.kind === 'iteration') {
      yield* allNodes(node.config.subgraph)
    }
  }
}

/** Every graph in the tree — the top level plus each iteration subgraph. */
export function allGraphs(graph: WorkflowGraph): WorkflowGraph[] {
  const out = [graph]
  for (const node of graph.nodes) {
    if (node.kind === 'iteration') out.push(...allGraphs(node.config.subgraph))
  }
  return out
}

/** The top-level trigger's kind, or null when the graph has no trigger. */
export function triggerKindOf(args: {
  graph: Pick<WorkflowGraph, 'nodes'> | undefined
}): string | null {
  const trigger = args.graph?.nodes.find((n) => n.kind === 'trigger')
  return trigger?.kind === 'trigger' ? trigger.config.triggerKind : null
}
