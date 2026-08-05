import {
  SWITCH_DEFAULT_CASE,
  type WorkflowGraph,
  type WorkflowNode,
} from './graph'
import { graphShapeFacts, joinViolation, switchCoverage } from './graph-rules'
import { analyzeJoinTopology } from './graph-topology'

// Author-time graph diagnostics. Where `workflowGraphSchema`'s superRefine is
// the strict *runtime* gate (a failing graph can't run), this collects the same
// problems — plus softer, per-node "not configured yet" issues — as a
// non-blocking list the editor can render in its "Issues" panel and use to
// highlight the offending nodes. It never throws: a work-in-progress graph is
// expected to have issues while it's being built.
//
// Intentionally mirrors (rather than imports) the superRefine's structural
// checks: the two answer different questions (reject-vs-run here, guide-the-
// author there) and diverge on severity — e.g. a dangling node is only a
// warning here but never rejects a runnable graph there.

export type GraphIssueSeverity = 'error' | 'warning'

export type GraphIssue = {
  /**
   * The node this issue attaches to, for canvas highlighting. Omitted for
   * graph-wide problems (e.g. "no trigger node").
   */
  nodeId?: string
  /** Human-readable node label at collection time, for display. */
  nodeLabel?: string
  message: string
  severity: GraphIssueSeverity
}

// Per-node "is this configured enough to run?" checks that need no external
// metadata (tool/agent catalogs). Binding-completeness lives in the UI layer,
// which has the catalogs to know a node's required inputs.
function configIssue(node: WorkflowNode): GraphIssue | null {
  const base = { nodeId: node.id, nodeLabel: node.label } as const
  switch (node.kind) {
    case 'agent':
      if (!node.config.agentId) {
        return { ...base, severity: 'error', message: 'No agent selected.' }
      }
      return null
    case 'branch': {
      const needsValue = !['is_empty', 'is_not_empty'].includes(
        node.config.operator,
      )
      if (needsValue && node.config.value === undefined) {
        return {
          ...base,
          severity: 'warning',
          message: `Branch "${node.config.operator}" has no value to compare against.`,
        }
      }
      return null
    }
    case 'workflow':
      if (!node.config.workflowId) {
        return { ...base, severity: 'error', message: 'No workflow selected.' }
      }
      return null
    case 'feature-request':
      if (!node.config.description.trim()) {
        return {
          ...base,
          severity: 'warning',
          message:
            'Feature-request note is empty — this node just passes through.',
        }
      }
      return null
    case 'iteration':
      // A list must be chosen — a `ref` into an upstream node's array output.
      if (node.config.source === undefined) {
        return {
          ...base,
          severity: 'error',
          message: 'No list selected — pick the list to iterate over.',
        }
      }
      // Only the item-trigger + output bookends → the loop does no work.
      if (node.config.subgraph.nodes.length <= 2) {
        return {
          ...base,
          severity: 'warning',
          message:
            'Iteration subgraph is empty — add nodes between Item and Output.',
        }
      }
      return null
    case 'output':
      // The value the caller receives must be named explicitly — a `ref` into an
      // upstream node's output. Unbound is a hard error: the run would have no
      // result to return (mirrors iteration's "no list selected"). The incoming
      // edge only decides WHEN this Output fires, not WHAT it returns.
      if (node.config.source === undefined) {
        return {
          ...base,
          severity: 'error',
          message:
            'No value bound — pick the upstream result the caller should receive.',
        }
      }
      return null
    default:
      return null
  }
}

/**
 * Above this many real work nodes, an item is "a pipeline" rather than "a step",
 * and replaying the whole thing on any inner failure starts to hurt. Deliberately
 * low: the point is to prompt a decision, not to police one.
 */
const HEAVY_SUBGRAPH_NODE_COUNT = 3

// Does one item do enough work that per-node durability is worth an instance
// start? An agent (or a nested workflow call) alone qualifies — it's the
// expensive, retry-prone, minutes-long kind of node whose replay an author most
// wants to avoid paying for twice.
function subgraphWeight(node: Extract<WorkflowNode, { kind: 'iteration' }>): {
  workNodes: number
  hasExpensiveNode: boolean
} {
  const work = node.config.subgraph.nodes.filter(
    (n) => n.kind !== 'trigger' && n.kind !== 'output' && n.kind !== 'note',
  )
  return {
    workNodes: work.length,
    hasExpensiveNode: work.some(
      (n) => n.kind === 'agent' || n.kind === 'workflow',
    ),
  }
}

/**
 * Flag an iteration whose SHAPE disagrees with its `itemExecution` choice.
 *
 * Both directions are only ever warnings: either setting runs correctly, and
 * which one is right depends on list length — which isn't knowable at author
 * time. This is the editor telling the author what it can see (how much work one
 * item does) so they can weigh it against what only they know (how many items
 * there usually are).
 */
function iterationExecutionIssue(node: WorkflowNode): GraphIssue | null {
  if (node.kind !== 'iteration') {
    return null
  }
  const base = { nodeId: node.id, nodeLabel: node.label } as const
  const { workNodes, hasExpensiveNode } = subgraphWeight(node)
  const heavy = hasExpensiveNode || workNodes > HEAVY_SUBGRAPH_NODE_COUNT

  if (node.config.itemExecution === 'inline' && heavy) {
    const why = hasExpensiveNode
      ? 'runs an agent'
      : `has ${workNodes} steps`
    return {
      ...base,
      severity: 'warning',
      message: `Each item ${why} but runs as one all-or-nothing unit — if it fails partway the whole item repeats from the start, and the inner steps' own timeout and retry settings are ignored. Consider switching item execution to Durable.`,
    }
  }

  if (node.config.itemExecution === 'durable' && !heavy) {
    return {
      ...base,
      severity: 'warning',
      message:
        'Each item starts its own run, which for a subgraph this small usually costs more than the durability is worth — especially over a long list. Inline is normally the better fit here.',
    }
  }

  return null
}

// Collect every author-time issue for a graph. Pure and metadata-free — the UI
// appends binding-completeness issues (missing required inputs) on top.
export function collectGraphIssues(graph: WorkflowGraph): GraphIssue[] {
  const issues: GraphIssue[] = []
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))

  // Shared join/cone analysis (adjacency, decision sources, sealed cones) — the
  // same reasoning the strict schema uses, so author-time flags match runtime
  // rejects. See graph-topology.ts.
  const topo = analyzeJoinTopology(graph)
  const { incoming, outgoing } = topo

  // ── Graph-wide shape ──────────────────────────────────────────────────────
  const shape = graphShapeFacts(graph)
  if (shape.triggerCount === 0) {
    issues.push({ severity: 'error', message: 'Graph has no trigger node.' })
  } else if (shape.triggerCount > 1) {
    issues.push({
      severity: 'error',
      message: `Graph has ${shape.triggerCount} trigger nodes; exactly one is allowed.`,
    })
  }
  if (!shape.hasOutput) {
    issues.push({ severity: 'error', message: 'Graph has no output node.' })
  }
  for (const e of shape.danglingEdges) {
    issues.push({
      severity: 'error',
      message: `Connection references a missing node (${e.source} → ${e.target}).`,
    })
  }

  // ── Per-node ──────────────────────────────────────────────────────────────
  for (const node of graph.nodes) {
    const base = { nodeId: node.id, nodeLabel: node.label } as const
    const inc = incoming.get(node.id) ?? []
    const out = outgoing.get(node.id) ?? []

    // Config completeness.
    const cfg = configIssue(node)
    if (cfg) issues.push(cfg)

    // Execution-shape advice (iteration item durability). Separate from
    // `configIssue`, which answers "is this configured enough to run?" — this one
    // answers "will this run the way you want when something fails?", and both
    // can legitimately fire on the same node.
    const exec = iterationExecutionIssue(node)
    if (exec) issues.push(exec)

    // Connectivity. A Note is a portless canvas annotation — it is meant to be
    // unconnected, so it's exempt from both connectivity checks.
    if (node.kind !== 'trigger' && node.kind !== 'note' && inc.length === 0) {
      issues.push({
        ...base,
        severity: 'error',
        message: 'Not connected — nothing feeds into this node.',
      })
    }
    if (node.kind !== 'output' && node.kind !== 'note' && out.length === 0) {
      issues.push({
        ...base,
        severity: 'warning',
        message: 'Nothing downstream — this node’s result is never used.',
      })
    }

    // A Race joins many upstreams and fires on the first to finish. With only
    // one input it can't race anything — it degenerates to a plain pass-through.
    if (node.kind === 'race' && inc.length === 1) {
      issues.push({
        ...base,
        severity: 'warning',
        message:
          'A race needs 2+ inputs to have anything to race — with one it just passes through.',
      })
    }

    // An Aggregate collects many upstreams into a list. With a single input it
    // just wraps that one value in a one-element list — usually not intended.
    if (node.kind === 'aggregate' && inc.length === 1) {
      issues.push({
        ...base,
        severity: 'warning',
        message:
          'An aggregate needs 2+ inputs to collect — with one it just wraps it in a single-item list.',
      })
    }

    // A binary decision node (branch) may connect just one arm — the other
    // is allowed to "fizzle out" (that path simply ends). So a missing yes/no
    // edge is not flagged; the generic "nothing downstream" warning above still
    // covers a decision node with no outgoing edges at all.

    // A switch needs an outgoing edge per case plus a 'default' fallback.
    if (node.kind === 'switch') {
      const { missingCases, hasDefault } = switchCoverage(node, out)
      if (missingCases.length > 0) {
        const many = missingCases.length > 1
        issues.push({
          ...base,
          severity: 'error',
          message: `Switch case${many ? 's' : ''} ${missingCases
            .map((k) => `"${k}"`)
            .join(', ')} ${many ? 'have' : 'has'} no outgoing edge.`,
        })
      }
      if (!hasDefault) {
        issues.push({
          ...base,
          severity: 'error',
          message: `Switch needs a "${SWITCH_DEFAULT_CASE}" (fallback) path.`,
        })
      }
    }

    // Join legality (shares the fact-producer with the strict schema, formats a
    // softer message here). A Race accepts any fan-in; an Output must not merge
    // parallel paths; a work node must not join both arms of one decision.
    const join = joinViolation(node, topo, graph.edges)
    if (join?.kind === 'parallel-output-merge') {
      issues.push({
        ...base,
        severity: 'error',
        message:
          'Merges parallel paths — only mutually-exclusive branch arms may share one Output. Give each path its own Output.',
      })
    } else if (join?.kind === 'both-arms-join') {
      const branch = byId.get(join.decisionId)
      issues.push({
        ...base,
        severity: 'error',
        message: `Joins both arms of branch "${branch?.label ?? join.decisionId}" — those paths never run together, so this node would stall. Route each arm to its own Output.`,
      })
    }
  }

  // Descend into iteration containers: their subgraph is a real mini-graph
  // (Item trigger → work → Result output) whose nodes are flattened onto the
  // same canvas, so their issues must surface too. Without this, a misconfigured
  // or unconnected node inside a loop is silently un-flagged. Nested iteration
  // is disallowed by the schema, so this recursion is one level deep.
  for (const node of graph.nodes) {
    if (node.kind === 'iteration') {
      issues.push(...collectGraphIssues(node.config.subgraph))
    }
  }

  return issues
}
