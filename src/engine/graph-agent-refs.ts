import type { AgentNode, WorkflowGraph, WorkflowNode } from './graph'
import type { GraphIssue } from './graph-issues'

// Agent-node pointer drift — the sibling of `graph-tool-args.ts`, for the other
// thing a node stores as a bare id it cannot verify.
//
// An agent node is a pure pointer: `config.agentId`, optionally pinned to a
// `version`. Nothing reconciles that pointer with the agents that exist. The
// structural lint only asks whether the field is EMPTY ("No agent selected"), so
// a populated-but-dangling id — an agent archived away, a deleted one, a pin on
// a version that was never published, or simply a typo'd uuid from a tool call —
// lints clean, publishes clean, and fails at run time inside
// `resolveRunManifest` with "references agent <id> (latest), which is not in the
// run manifest".
//
// That failure is the expensive kind: it happens after the publish, on a real
// trigger, and the author's last signal was a graph that said it was fine. The
// tool-arg lint exists for exactly this shape of problem one field over; this is
// the same check for the pointer.
//
// Pure function over an index, for the same reason `collectToolArgIssues` is:
// the editor already holds the agents list it renders its picker from, and the
// server holds the rows. One function over the common shape keeps the Issues
// panel and `validate_workflow_graph` from disagreeing about what is broken.

/** What the lint needs to know about one agent. */
export type AgentRefEntry = {
  name: string
  /**
   * Whether it is archived. Archived agents leave the node picker but still
   * RESOLVE at run time, so a graph pointing at one keeps working — which is
   * why this is a warning and not an error.
   */
  archived?: boolean
  /**
   * The highest published version number, or `null` for an agent that has never
   * been published. A node floating to latest has nothing to freeze when this is
   * `null`.
   */
  latestVersionNumber: number | null
  /**
   * Every published version number, for judging a node's `version` pin. Omit
   * when the caller cannot cheaply supply it — a pin is then only checked
   * against `latestVersionNumber`, which still catches a pin above the newest
   * version and is the common case.
   */
  versionNumbers?: ReadonlySet<number>
}

/** Agent id → what the lint knows about it. Absent key = no such agent. */
export type AgentRefIndex = ReadonlyMap<string, AgentRefEntry>

/**
 * Every agent node in the graph — including those inside iteration subgraphs,
 * which are the ones an author is least likely to re-open.
 */
function* agentNodes(nodes: WorkflowNode[]): Generator<AgentNode> {
  for (const n of nodes) {
    if (n.kind === 'agent') yield n
    else if (n.kind === 'iteration') yield* agentNodes(n.config.subgraph.nodes)
  }
}

/**
 * Issues where an agent node's pointer does not resolve:
 *
 * - the `agentId` names no agent at all — error, the run cannot build a manifest
 * - the agent exists but has never been published — error, there is no version
 *   to float to
 * - the node pins a `version` that was never published — error
 * - the agent is archived — warning; it still runs, but it is gone from the
 *   picker, so re-opening the node and saving would blank it
 *
 * An empty `agentId` is deliberately NOT reported: the structural lint already
 * says "No agent selected", and two lines for one unconfigured node is noise.
 */
export function collectAgentRefIssues(
  graph: WorkflowGraph,
  agents: AgentRefIndex,
): GraphIssue[] {
  const issues: GraphIssue[] = []
  for (const node of agentNodes(graph.nodes)) {
    const base = { nodeId: node.id, nodeLabel: node.label } as const
    const agentId = node.config.agentId
    // Unconfigured, not broken — `collectGraphIssues` owns this one.
    if (!agentId) continue

    const agent = agents.get(agentId)
    if (!agent) {
      issues.push({
        ...base,
        severity: 'error',
        message: `No agent has the id "${agentId}", so this node cannot run — the run fails while freezing its manifest, before any step is recorded. Point it at an agent that exists.`,
      })
      continue
    }

    if (agent.latestVersionNumber == null) {
      issues.push({
        ...base,
        severity: 'error',
        message: `Agent "${agent.name}" has never been published, so there is no version for this node to run. Publish it first.`,
      })
      continue
    }

    const pin = node.config.version
    if (pin != null) {
      const known =
        agent.versionNumbers?.has(pin) ??
        // No version list supplied: a pin at or below the newest version is
        // assumed real. Catches the common error (a pin above latest) without
        // inventing a failure for a gap the caller cannot see.
        pin <= agent.latestVersionNumber
      if (!known) {
        issues.push({
          ...base,
          severity: 'error',
          message: `This node is pinned to version ${pin} of "${agent.name}", which is not a published version (latest is ${agent.latestVersionNumber}). Re-pin it, or clear the pin to follow the latest.`,
        })
        continue
      }
    }

    if (agent.archived) {
      issues.push({
        ...base,
        severity: 'warning',
        message: `Agent "${agent.name}" is archived. This node still runs it, but the agent is hidden from the picker — re-selecting an agent here would lose the reference.`,
      })
    }
  }
  return issues
}
