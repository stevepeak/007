import {
  SWITCH_DEFAULT_CASE,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
} from './graph-schema'
import { bothArmsJoinDecision, type JoinTopology } from './graph-topology'

// Shared *facts* behind the structural rules that both the strict runtime gate
// (`graph-validation.ts`) and the author-time diagnostics (`graph-issues.ts`)
// apply. The two deliberately diverge on wording and severity — reject-vs-run
// there, guide-the-author here — but they must agree on the underlying rule. So
// the graph-walk that decides *whether* a rule is violated lives here ONCE and
// each caller formats its own message/severity from these facts. (The join/cone
// analysis they both build on lives one layer down, in `graph-topology.ts`.)

/**
 * Graph-wide shape facts: trigger count, output presence, id uniqueness, edges
 * whose endpoints don't resolve, and Output nodes with no incoming edge. Callers
 * pick the subset they report — the author-time collector, for instance, surfaces
 * unreachable outputs through its per-node connectivity check instead.
 */
export function graphShapeFacts(graph: WorkflowGraph): {
  triggerCount: number
  hasOutput: boolean
  hasDuplicateIds: boolean
  danglingEdges: WorkflowEdge[]
  outputIdsMissingIncoming: string[]
} {
  const triggerCount = graph.nodes.filter((n) => n.kind === 'trigger').length
  const hasOutput = graph.nodes.some((n) => n.kind === 'output')
  const ids = new Set(graph.nodes.map((n) => n.id))
  const hasDuplicateIds = ids.size !== graph.nodes.length
  const danglingEdges = graph.edges.filter(
    (e) => !ids.has(e.source) || !ids.has(e.target),
  )
  const outputIdsMissingIncoming = graph.nodes
    .filter(
      (n) =>
        n.kind === 'output' && !graph.edges.some((e) => e.target === n.id),
    )
    .map((n) => n.id)
  return {
    triggerCount,
    hasOutput,
    hasDuplicateIds,
    danglingEdges,
    outputIdsMissingIncoming,
  }
}

/**
 * Switch coverage: the declared case keys with no matching outgoing edge, and
 * whether the optional `else` fallback edge exists. `outgoing` is the switch
 * node's own outgoing edges.
 */
export function switchCoverage(
  node: Extract<WorkflowNode, { kind: 'switch' }>,
  outgoing: WorkflowEdge[],
): { missingCases: string[]; hasDefault: boolean } {
  const conds = new Set(outgoing.map((e) => e.condition))
  const missingCases = node.config.cases
    .map((c) => c.key)
    .filter((k) => !conds.has(k))
  return { missingCases, hasDefault: conds.has(SWITCH_DEFAULT_CASE) }
}

/**
 * The scheduler-illegal fan-in shape for `node`, or `null` if its join is legal.
 * A Race (`some` readiness) accepts any fan-in. An Output must not merge two+
 * always-live paths (one would be silently dropped). A work node (`every`
 * readiness) stalls forever if a single decision feeds both its arms into it.
 * Mirrors the scheduler's readiness rule; the cone/decision analysis comes from
 * the shared `topo`.
 */
export type JoinViolation =
  | { kind: 'parallel-output-merge'; count: number }
  | { kind: 'both-arms-join'; decisionId: string }
  | null

export function joinViolation(
  node: WorkflowNode,
  topo: JoinTopology,
  edges: WorkflowEdge[],
): JoinViolation {
  const incoming = topo.incoming.get(node.id) ?? []
  if (incoming.length < 2) return null
  if (node.kind === 'race') return null
  if (node.kind === 'output') {
    const count = incoming.filter((e) => !topo.isConditional(e.source)).length
    return count >= 2 ? { kind: 'parallel-output-merge', count } : null
  }
  const d = bothArmsJoinDecision(
    node.id,
    topo.ancestorCone(node.id),
    topo.decisionIds,
    edges,
  )
  return d ? { kind: 'both-arms-join', decisionId: d } : null
}
