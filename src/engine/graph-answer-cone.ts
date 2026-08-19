import type { WorkflowGraph } from './graph'
import { ancestorIds } from './graph-traverse'

// Which nodes can influence the run's answer, and which are background work.
//
// A graph legitimately carries arms that never feed an Output — a chat-title
// update, a notification, an indexing tool hung off the trigger. Those are
// "orphan" only in the sense that nothing downstream of them reaches the
// caller; they are supposed to run, just not to be waited on. Naming that
// distinction is what lets the walk start the answer's work first and settle
// the answer the moment its own arm reports.
//
// Structural, not runtime: this is the ancestor closure over ALL edges, taken
// before any branch has routed. A node on the untaken arm of a decision is
// still answer-critical here — it just never becomes ready. Being permissive is
// the safe direction: mis-classifying a node as critical costs nothing but
// dispatch order, while mis-classifying one as background could deprioritize
// the very node the answer waits on.

/**
 * Node ids that can contribute to some Output's value — every Output node plus
 * its full structural ancestor closure. Everything else in the graph is
 * background.
 *
 * Uses {@link ancestorIds} (a plain reverse BFS) rather than
 * `analyzeJoinTopology`'s `ancestorCone`, which deliberately seals at `race`
 * nodes for its own join analysis. A race's producers very much do feed the
 * answer, so sealing there would demote them.
 *
 * An author can demote a node explicitly with `execution.background: true` —
 * the escape hatch for a side-effect node that happens to sit in the cone (it
 * still runs, it just yields dispatch order to the answer). Demoting a node
 * does NOT demote its ancestors: they may feed the answer by another path, and
 * this pass has no reason to guess.
 */
export function answerCriticalIds(graph: WorkflowGraph): Set<string> {
  const critical = new Set<string>()
  for (const node of graph.nodes) {
    if (node.kind !== 'output') continue
    critical.add(node.id)
    for (const id of ancestorIds(graph, node.id)) critical.add(id)
  }
  for (const node of graph.nodes) {
    if (node.execution?.background) critical.delete(node.id)
  }
  return critical
}
