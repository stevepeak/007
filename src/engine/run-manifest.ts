import type { AgentConfig, WorkflowGraph } from './graph-schema'

// Frozen-at-run-start resolution of every floating reference in a workflow to
// the exact published version it ran against. Stored on `wf_run.manifest` so a
// run is fully reproducible even as its leaf agents drift. Entries are
// self-describing (carry `config`) so a run needs no live agent rows to replay.
export type WfAgentManifestEntry = {
  kind: 'agent'
  /** The stable `wf_agent.id` an agent node references. */
  id: string
  /**
   * The pin this entry was resolved for: `null` for nodes that float to
   * latest, or the exact version number a node pinned. A single run can hold
   * several entries for the same `id` when different nodes pin the same agent
   * differently — the pin is part of the lookup key.
   */
  pinnedVersion: number | null
  versionId: string
  versionNumber: number
  name: string
  config: AgentConfig
}

// A called workflow resolved to the exact published version it ran against, with
// its graph frozen in so the sub-run replays even as the callee drifts. Its
// graph may itself reference agents / further workflows; run-start resolution is
// transitive, so every reachable entry lands in the same flat manifest.
export type WfWorkflowManifestEntry = {
  kind: 'workflow'
  /** The stable `wf_workflow.id` a workflow node references. */
  id: string
  versionId: string
  versionNumber: number
  name: string
  /** The frozen published graph, executed inline as a subgraph at run time. */
  graph: WorkflowGraph
}

export type WfRunManifestEntry = WfAgentManifestEntry | WfWorkflowManifestEntry

/**
 * Look up the resolved agent entry for an `agentId` + version pin in a run
 * manifest. `version` is the node's pin: `null`/undefined matches the
 * float-to-latest entry, a number matches the entry frozen for that pin.
 */
export function agentFromManifest(
  manifest: readonly WfRunManifestEntry[],
  agentId: string,
  version: number | null = null,
): WfAgentManifestEntry | undefined {
  return manifest.find(
    (e): e is WfAgentManifestEntry =>
      e.kind === 'agent' &&
      e.id === agentId &&
      // Manifests frozen before pinning existed have no `pinnedVersion`; treat
      // a missing value as `null` (float-to-latest) so old runs still resolve.
      (e.pinnedVersion ?? null) === (version ?? null),
  )
}

/** Look up the resolved workflow entry for a `workflowId` in a run manifest. */
export function workflowFromManifest(
  manifest: readonly WfRunManifestEntry[],
  workflowId: string,
): WfWorkflowManifestEntry | undefined {
  return manifest.find(
    (e): e is WfWorkflowManifestEntry =>
      e.kind === 'workflow' && e.id === workflowId,
  )
}
