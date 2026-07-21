import type { WorkflowEdge, WorkflowGraph } from './graph'

// The join/cone topology analysis shared by the strict runtime gate
// (`workflowGraphSchema.superRefine`) and the author-time diagnostics
// (`collectGraphIssues`). Both must agree on which fan-ins are illegal — a graph
// the editor reports clean must run, and one it flags must be the one the schema
// rejects — so the graph-walk reasoning lives here ONCE and each caller supplies
// only its own severity/message. (Type-only import of graph.ts keeps this a leaf
// module with no import cycle; the decision-kind test is inlined for the same
// reason — it mirrors `isDecisionKind`.)

// Decision *kinds* — nodes that route via a conditional outgoing edge. Mirrors
// `isDecisionKind` in graph.ts (kept inline to avoid a runtime import cycle).
function isDecisionNodeKind(kind: string): boolean {
  return kind === 'branch' || kind === 'switch'
}

export type JoinTopology = {
  /** Incoming edges keyed by target node id. */
  incoming: Map<string, WorkflowEdge[]>
  /** Outgoing edges keyed by source node id. */
  outgoing: Map<string, WorkflowEdge[]>
  /**
   * Nodes that route via a conditional outgoing edge — decision *kinds*
   * (branch/switch) plus any node carrying a conditioned edge (e.g. a YES/NO
   * agent, whose decision-ness is only visible graph-locally as that edge).
   */
  decisionIds: Set<string>
  /**
   * True when a node's execution depends on a decision outcome — it IS a
   * decision, or descends from one.
   */
  isConditional(nodeId: string): boolean
  /**
   * Ancestor cone of a node, SEALED at Race nodes: a Race is included as a
   * boundary but its predecessors are not. A Race fires on the first live arm
   * and always completes, collapsing a branch, so paths through it no longer
   * count as joining "both arms".
   */
  ancestorCone(nodeId: string): Set<string>
}

export function analyzeJoinTopology(graph: WorkflowGraph): JoinTopology {
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

  const decisionIds = new Set(
    graph.nodes.filter((n) => isDecisionNodeKind(n.kind)).map((n) => n.id),
  )
  for (const e of graph.edges) {
    if (e.condition != null) decisionIds.add(e.source)
  }

  // A node is conditional iff it has a decision ancestor — equivalently, it is
  // forward-reachable from some decision's outgoing edge. One O(V+E) sweep.
  const conditional = new Set<string>()
  const stack = graph.edges
    .filter((e) => decisionIds.has(e.source))
    .map((e) => e.target)
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (conditional.has(id)) continue
    conditional.add(id)
    for (const e of outgoing.get(id) ?? []) stack.push(e.target)
  }

  const raceIds = new Set(
    graph.nodes.filter((n) => n.kind === 'race').map((n) => n.id),
  )

  const ancestorCone = (nodeId: string): Set<string> => {
    const seen = new Set<string>()
    const walk = (incoming.get(nodeId) ?? []).map((e) => e.source)
    while (walk.length > 0) {
      const id = walk.pop() as string
      if (seen.has(id)) continue
      seen.add(id)
      if (raceIds.has(id)) continue // boundary: don't traverse past a Race
      for (const e of incoming.get(id) ?? []) walk.push(e.source)
    }
    return seen
  }

  return {
    incoming,
    outgoing,
    decisionIds,
    isConditional: (nodeId) =>
      decisionIds.has(nodeId) || conditional.has(nodeId),
    ancestorCone,
  }
}

/**
 * The decision node whose BOTH arms feed `nodeId` — the mutually-exclusive join
 * that stalls an all-inputs (`every`) work node forever — or null if none. Only
 * arms that can still reach `nodeId` (its Race-sealed ancestor `cone`) count.
 */
export function bothArmsJoinDecision(
  nodeId: string,
  cone: Set<string>,
  decisionIds: Set<string>,
  edges: WorkflowEdge[],
): string | null {
  for (const d of decisionIds) {
    if (!cone.has(d)) continue
    const arms = new Set<string>()
    for (const e of edges) {
      if (e.source !== d || !e.condition) continue
      // This arm feeds `nodeId` iff its target can still reach it.
      if (e.target === nodeId || cone.has(e.target)) arms.add(e.condition)
    }
    if (arms.size >= 2) return d
  }
  return null
}
