import type { WorkflowGraph } from '../../engine/graph'

// Pure graph-walk helpers shared by the authoring modules (workflow reference
// listing and run-manifest resolution). No DB, no siblings — just structural
// traversal of a `WorkflowGraph`.

// Every node in a graph, INCLUDING those nested inside iteration subgraphs. An
// iteration node's subgraph runs as an inline graph once per item, and those
// per-item nodes resolve against the SAME flat run manifest — so an agent or a
// sub-workflow call living inside a subgraph must contribute to the manifest
// just as a top-level one does. (Iteration can't nest, but a subgraph may hold a
// `workflow` node, whose callee is resolved transitively by `resolveInto`.)
export function* allNodes(
  graph: WorkflowGraph,
): Generator<WorkflowGraph['nodes'][number]> {
  for (const node of graph.nodes) {
    yield node
    if (node.kind === 'iteration') {
      yield* allNodes(node.config.subgraph)
    }
  }
}

// Distinct non-empty values a per-node `pick` yields across the graph (incl.
// iteration subgraphs) — the shared walk behind the id collectors below.
export function distinctFromNodes(
  graph: WorkflowGraph,
  pick: (node: WorkflowGraph['nodes'][number]) => string | undefined,
): string[] {
  const ids = new Set<string>()
  for (const node of allNodes(graph)) {
    const value = pick(node)
    if (value) ids.add(value)
  }
  return [...ids]
}

// Distinct agent ids referenced by agent nodes in a graph (incl. subgraphs).
export function agentIdsInGraph(graph: WorkflowGraph): string[] {
  return distinctFromNodes(graph, (node) =>
    node.kind === 'agent' ? node.config.agentId : undefined,
  )
}

// Distinct (agentId, version-pin) pairs referenced by agent nodes (incl. those
// inside iteration subgraphs). Two nodes pinning the same agent to different
// versions yield two pairs, so each gets its own manifest entry. `version` is
// `null` for float-to-latest nodes.
export function agentPinsInGraph(
  graph: WorkflowGraph,
): { agentId: string; version: number | null }[] {
  const seen = new Map<string, { agentId: string; version: number | null }>()
  for (const node of allNodes(graph)) {
    if (node.kind === 'agent' && node.config.agentId) {
      const version = node.config.version ?? null
      const key = `${node.config.agentId}@${version ?? 'latest'}`
      if (!seen.has(key))
        seen.set(key, { agentId: node.config.agentId, version })
    }
  }
  return [...seen.values()]
}

// Distinct workflow ids called by workflow nodes in a graph (incl. subgraphs).
export function workflowIdsInGraph(graph: WorkflowGraph): string[] {
  return distinctFromNodes(graph, (node) =>
    node.kind === 'workflow' ? node.config.workflowId : undefined,
  )
}

// Hard cap on nested-workflow depth. A guard against pathological chains; real
// graphs never come close. Reference cycles are caught earlier (by `stack`), so
// this only bounds honest but absurdly deep call trees.
export const MAX_WORKFLOW_DEPTH = 16
