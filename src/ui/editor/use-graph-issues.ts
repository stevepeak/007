import { useMemo } from 'react'

import {
  collectGraphIssues,
  type GraphIssue,
  type WorkflowGraph,
  type WorkflowNode,
} from '../../engine'
import { useIoMaps } from './node-data-panel'
import { missingRequiredInputs, raceInputShapeCount } from './node-io'

// The editor's full issue list: the engine's metadata-free structural + config
// checks (`collectGraphIssues`), plus binding-completeness — which needs the
// tool/agent catalogs to know each node's required inputs. Returned sorted
// errors-first so the Issues panel and the "worst first" node highlight agree.
export function useGraphIssues(graph: WorkflowGraph): GraphIssue[] {
  const maps = useIoMaps()
  return useMemo(() => {
    const structural = collectGraphIssues(graph)

    const bindingIssues: GraphIssue[] = []
    const checkBindings = (node: WorkflowNode) => {
      for (const key of missingRequiredInputs(node, maps)) {
        bindingIssues.push({
          nodeId: node.id,
          nodeLabel: node.label,
          severity: 'error',
          message: `Required input "${key}" isn’t linked to any data.`,
        })
      }
    }
    for (const node of graph.nodes) {
      checkBindings(node)
      // Nodes inside an iteration loop are flattened onto the canvas but live in
      // `config.subgraph.nodes`; check their bindings too, else a missing link on
      // a looped tool (e.g. `embed_and_upsert`) never surfaces until a run fails.
      if (node.kind === 'iteration') {
        for (const child of node.config.subgraph.nodes) checkBindings(child)
      }
      // A Race passes its winning input straight through, so its consumer only
      // sees one shape if every input has the same shape. Inferring shapes needs
      // the tool/agent catalogs, so this check lives here rather than in the
      // engine's metadata-free `collectGraphIssues`.
      if (node.kind === 'race' && raceInputShapeCount(graph, node.id, maps) > 1) {
        bindingIssues.push({
          nodeId: node.id,
          nodeLabel: node.label,
          severity: 'warning',
          message:
            'Inputs have different shapes — a race must join producers of the same shape so its consumer sees one consistent result.',
        })
      }
    }

    const all = [...structural, ...bindingIssues]
    // Errors before warnings; otherwise stable in discovery order.
    return all
      .map((issue, i) => ({ issue, i }))
      .sort((a, b) => {
        const sev =
          Number(a.issue.severity === 'warning') -
          Number(b.issue.severity === 'warning')
        return sev !== 0 ? sev : a.i - b.i
      })
      .map((x) => x.issue)
  }, [graph, maps])
}

// The node ids that have at least one blocking (error) issue — used to highlight
// misconfigured nodes on the canvas.
export function invalidNodeIdsOf(issues: GraphIssue[]): Set<string> {
  const ids = new Set<string>()
  for (const issue of issues) {
    if (issue.severity === 'error' && issue.nodeId) ids.add(issue.nodeId)
  }
  return ids
}
