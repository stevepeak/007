import {
  isDecisionKind,
  SWITCH_DEFAULT_CASE,
  type WorkflowGraph,
  type WorkflowNode,
} from './graph'

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

// Every node with a directed path into `nodeId` (its ancestor cone).
function ancestorCone(
  nodeId: string,
  incoming: Map<string, WorkflowGraph['edges']>,
): Set<string> {
  const seen = new Set<string>()
  const stack = (incoming.get(nodeId) ?? []).map((e) => e.source)
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (seen.has(id)) continue
    seen.add(id)
    for (const e of incoming.get(id) ?? []) stack.push(e.source)
  }
  return seen
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
      // A list must be chosen (undefined = never picked; '' is the valid
      // "whole input is the list" selection).
      if (node.config.itemsPath === undefined) {
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
    default:
      return null
  }
}

// Collect every author-time issue for a graph. Pure and metadata-free — the UI
// appends binding-completeness issues (missing required inputs) on top.
export function collectGraphIssues(graph: WorkflowGraph): GraphIssue[] {
  const issues: GraphIssue[] = []
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))

  const incoming = new Map<string, WorkflowGraph['edges']>()
  const outgoing = new Map<string, WorkflowGraph['edges']>()
  for (const e of graph.edges) {
    const inc = incoming.get(e.target)
    if (inc) inc.push(e)
    else incoming.set(e.target, [e])
    const out = outgoing.get(e.source)
    if (out) out.push(e)
    else outgoing.set(e.source, [e])
  }

  // ── Graph-wide shape ──────────────────────────────────────────────────────
  const triggers = graph.nodes.filter((n) => n.kind === 'trigger')
  if (triggers.length === 0) {
    issues.push({ severity: 'error', message: 'Graph has no trigger node.' })
  } else if (triggers.length > 1) {
    issues.push({
      severity: 'error',
      message: `Graph has ${triggers.length} trigger nodes; exactly one is allowed.`,
    })
  }
  if (!graph.nodes.some((n) => n.kind === 'output')) {
    issues.push({ severity: 'error', message: 'Graph has no output node.' })
  }
  for (const e of graph.edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) {
      issues.push({
        severity: 'error',
        message: `Connection references a missing node (${e.source} → ${e.target}).`,
      })
    }
  }

  // Decision cone membership, for the mutually-exclusive-join check below.
  const decisionIds = new Set(
    graph.nodes.filter((n) => isDecisionKind(n.kind)).map((n) => n.id),
  )
  // A node is "conditional" when it — or any ancestor — is a decision node, so
  // its execution depends on a branch outcome.
  const isConditional = (nodeId: string): boolean =>
    decisionIds.has(nodeId) ||
    [...ancestorCone(nodeId, incoming)].some((id) => decisionIds.has(id))

  // ── Per-node ──────────────────────────────────────────────────────────────
  for (const node of graph.nodes) {
    const base = { nodeId: node.id, nodeLabel: node.label } as const
    const inc = incoming.get(node.id) ?? []
    const out = outgoing.get(node.id) ?? []

    // Config completeness.
    const cfg = configIssue(node)
    if (cfg) issues.push(cfg)

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

    // A binary decision node (branch) may connect just one arm — the other
    // is allowed to "fizzle out" (that path simply ends). So a missing yes/no
    // edge is not flagged; the generic "nothing downstream" warning above still
    // covers a decision node with no outgoing edges at all.

    // A switch needs an outgoing edge per case plus a 'default' fallback.
    if (node.kind === 'switch') {
      const conds = new Set(out.map((e) => e.condition))
      const missingCases = node.config.cases
        .map((c) => c.key)
        .filter((k) => !conds.has(k))
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
      if (!conds.has(SWITCH_DEFAULT_CASE)) {
        issues.push({
          ...base,
          severity: 'error',
          message: `Switch needs a "${SWITCH_DEFAULT_CASE}" (fallback) path.`,
        })
      }
    }

    // Join legality (mirrors the strict schema).
    if (inc.length >= 2) {
      if (node.kind === 'output') {
        // Two always-live (unconditional) paths into one Output silently drop
        // one. Only mutually-exclusive branch arms may converge here.
        const unconditional = inc.filter((e) => !isConditional(e.source)).length
        if (unconditional >= 2) {
          issues.push({
            ...base,
            severity: 'error',
            message:
              'Merges parallel paths — only mutually-exclusive branch arms may share one Output. Give each path its own Output.',
          })
        }
      } else {
        const cone = ancestorCone(node.id, incoming)
        for (const d of decisionIds) {
          if (!cone.has(d)) continue
          const arms = new Set<string>()
          for (const e of graph.edges) {
            if (e.source !== d || !e.condition) continue
            if (e.target === node.id || cone.has(e.target))
              arms.add(e.condition)
          }
          if (arms.size >= 2) {
            const branch = byId.get(d)
            issues.push({
              ...base,
              severity: 'error',
              message: `Joins both arms of branch "${branch?.label ?? d}" — those paths never run together, so this node would stall. Route each arm to its own Output.`,
            })
            break
          }
        }
      }
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
