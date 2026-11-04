import type { DecisionAgentConfig } from './decision-agent-schema'
import type { AgentConfig, WorkflowGraph } from './graph-schema'

// Frozen-at-run-start resolution of every floating reference in a workflow to
// the exact published version it ran against. An entry carries the version's
// `config` or `graph` for the engine to execute; what is persisted is the
// `WfRunManifestRef` below, because version content is immutable.
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
  /**
   * The context window of the model this agent resolved to, frozen with the rest
   * of the entry. The engine needs it to stop a tool loop before the conversation
   * overflows the window, and it can't ask: the host's `getModel` hands back a
   * `LanguageModel`, not its metadata. Freezing it here rather than storing it on
   * the agent config also means it can't go stale when the author switches model.
   *
   * Undefined when the provider reports no context length — the guard then does
   * nothing rather than guessing a window.
   */
  contextLength?: number
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

// A DECISION agent resolved to the exact published version an agent node ran
// against. Its own entry kind rather than a widened `WfAgentManifestEntry`,
// because the two configs share no field: everything that reads a `kind: 'agent'`
// entry reaches straight for a prompt, a tool list and an output contract, none
// of which a decision agent has. Giving it a separate kind means a decision agent
// in a manifest is invisible to that code instead of being a config-shaped hole
// in the middle of it.
export type WfDecisionAgentManifestEntry = {
  kind: 'decision-agent'
  /** The stable `wf_agent.id` an agent node references. */
  id: string
  /** As {@link WfAgentManifestEntry.pinnedVersion}: null floats to latest. */
  pinnedVersion: number | null
  versionId: string
  versionNumber: number
  name: string
  /** The frozen question set, verdicts and rollup rules. */
  config: DecisionAgentConfig
}

export type WfRunManifestEntry =
  | WfAgentManifestEntry
  | WfDecisionAgentManifestEntry
  | WfWorkflowManifestEntry

/**
 * A manifest entry without its version content: what `wf_run.manifest` and a
 * spawned run's params hold. `hydrateRunManifest` loads the content back by
 * `versionId`. `name` and `contextLength` stay because no version row holds
 * them, and they are frozen for the run like everything else here.
 */
export type WfRunManifestRef =
  | Omit<WfAgentManifestEntry, 'config'>
  | Omit<WfDecisionAgentManifestEntry, 'config'>
  | Omit<WfWorkflowManifestEntry, 'graph'>

/**
 * Strip entries down to refs. Builds each ref field by field, since an entry is
 * assignable to a ref and the type alone would let its content through.
 */
export function toManifestRefs(
  manifest: readonly WfRunManifestRef[],
): WfRunManifestRef[] {
  return manifest.map((e): WfRunManifestRef => {
    const shared = {
      id: e.id,
      versionId: e.versionId,
      versionNumber: e.versionNumber,
      name: e.name,
    }
    if (e.kind === 'workflow') {
      return { kind: e.kind, ...shared }
    }
    const pinnedVersion = e.pinnedVersion ?? null
    if (e.kind === 'decision-agent') {
      return { kind: e.kind, pinnedVersion, ...shared }
    }
    return {
      kind: e.kind,
      pinnedVersion,
      ...shared,
      ...(e.contextLength === undefined
        ? {}
        : { contextLength: e.contextLength }),
    }
  })
}

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
  return manifest.find((e): e is WfAgentManifestEntry => {
    return (
      e.kind === 'agent' &&
      e.id === agentId &&
      // Manifests frozen before pinning existed have no `pinnedVersion`; treat
      // a missing value as `null` (float-to-latest) so old runs still resolve.
      (e.pinnedVersion ?? null) === (version ?? null)
    )
  })
}

/** Look up the resolved workflow entry for a `workflowId` in a run manifest. */
export function workflowFromManifest(
  manifest: readonly WfRunManifestEntry[],
  workflowId: string,
): WfWorkflowManifestEntry | undefined {
  return manifest.find((e): e is WfWorkflowManifestEntry => {
    return e.kind === 'workflow' && e.id === workflowId
  })
}

/**
 * Look up the resolved DECISION agent entry for an `agentId` + pin.
 *
 * Deliberately separate from {@link agentFromManifest} rather than a `kind`
 * parameter on it: a lookup for the wrong kind of agent must come back EMPTY
 * and fail with "not in the manifest" — not come back with an entry whose config is the wrong shape.
 * Two functions make that the default instead of a thing each caller remembers
 * to check.
 */
export function decisionAgentFromManifest(
  manifest: readonly WfRunManifestEntry[],
  agentId: string,
  version: number | null = null,
): WfDecisionAgentManifestEntry | undefined {
  return manifest.find((e): e is WfDecisionAgentManifestEntry => {
    return (
      e.kind === 'decision-agent' &&
      e.id === agentId &&
      (e.pinnedVersion ?? null) === (version ?? null)
    )
  })
}
