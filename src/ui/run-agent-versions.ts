import type { WfRunStepDTO } from '../server/protocol'

// Which agent version a run actually executed. An agent node is a pointer that
// usually FLOATS to the agent's latest published version, so the live catalog
// can't answer this after the fact — the run froze its answer into the manifest
// at start, and the recorder stamps it onto each agent step's meta
// (`AgentNodeMeta.agentVersion`). Reading it back here is what lets the run
// viewer name the version that ran rather than whatever is newest today.

/** The agent version a single recorded step ran, or null when unstamped. */
export function stepAgentVersion(
  step: Pick<WfRunStepDTO, 'meta'> | null | undefined,
): number | null {
  const v = (step?.meta as { agentVersion?: unknown } | null | undefined)
    ?.agentVersion
  return typeof v === 'number' ? v : null
}

/**
 * nodeId → the agent version that node ran. Iteration inner nodes record one
 * step per item, all against the same frozen version, so first-stamp-wins is
 * exact rather than a heuristic.
 */
export function runAgentVersions(
  steps: readonly Pick<WfRunStepDTO, 'nodeId' | 'meta'>[],
): Map<string, number> {
  const byNode = new Map<string, number>()
  for (const step of steps) {
    if (byNode.has(step.nodeId)) continue
    const version = stepAgentVersion(step)
    if (version != null) byNode.set(step.nodeId, version)
  }
  return byNode
}
