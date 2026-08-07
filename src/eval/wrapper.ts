import type { WorkflowGraph } from '../engine/graph'
import { MANUAL_TRIGGER_KIND } from '../engine/trigger-registry'
import type { WfDb } from '../storage/client'
import {
  createWorkflow,
  findWorkflowByName,
  getLatestVersionId,
  getVersionGraph,
  saveVersion,
} from '../storage/data'

// Phase 5 — target resolution. An eval always runs through the same
// GraphWorkflow path, so both target kinds must resolve to a `workflowVersionId`:
//   • workflow target → its own latest published version.
//   • agent target    → a hidden, auto-generated `trigger(manual) → agent → output`
//     wrapper workflow (created once per agent, cached by name). The agent node
//     floats to the agent's latest version, so the eval grades the identical
//     trace shape a real workflow agent-node would produce.

/** Stable name of an agent's wrapper workflow — also its cache key. */
export const EVAL_WRAPPER_NAME_PREFIX = 'eval-wrapper:'

/**
 * A wrapper's name doubles as its cache key. It must fold in the version pin so
 * a goal pinned to a specific version gets its own wrapper rather than reusing
 * the float-to-latest one. An unpinned (latest) target keeps the historic
 * `eval-wrapper:{agentId}` name for backward compatibility.
 */
export function evalWrapperName(
  agentId: string,
  version: number | null = null,
): string {
  return version == null
    ? `${EVAL_WRAPPER_NAME_PREFIX}${agentId}`
    : `${EVAL_WRAPPER_NAME_PREFIX}${agentId}@v${version}`
}

/**
 * The minimal runnable graph for an agent eval: a manual trigger wired through
 * an agent node (pointing at `agentId`) into an Output. `version` is the goal's
 * target pin — `null` floats to the agent's latest published version, a number
 * pins to that exact version. Pure — no db, no side effects.
 *
 * Ids are DERIVED, not random. A wrapper is regenerated on every
 * `ensureAgentEvalWrapper` call and compared against the stored one to detect
 * drift (see `stableStringify`); random ids would make every comparison differ
 * and republish forever. They stay internal to the frozen version and
 * are never referenced from outside it, so their form is free — readable beats
 * opaque when they show up in `wf_run_step.node_id` and Sentry `wf.node_id`.
 */
export function buildAgentWrapperGraph(
  agentId: string,
  version: number | null = null,
): WorkflowGraph {
  const pin = version == null ? 'latest' : `v${version}`
  const nodeId = (role: string) => `eval-wrapper:${agentId}:${pin}:${role}`
  const triggerId = nodeId('trigger')
  const agentNodeId = nodeId('agent')
  const outputId = nodeId('output')
  return {
    version: 1,
    nodes: [
      {
        id: triggerId,
        kind: 'trigger',
        label: 'Manual start',
        position: { x: 0, y: 0 },
        informUser: { mode: 'off' },
        config: {
          triggerKind: MANUAL_TRIGGER_KIND,
          // Evals run INLINE, not on Cloudflare Workflows. A wrapper is one
          // agent call with a caller waiting on the answer — it wants none of
          // what the durable backend is for. Durability bought nothing here and
          // cost a lot: `step.do` replays the whole node up to 4× against the
          // same failing provider under a 20-minute timeout, which is what
          // turned a Venice outage into cells that took ~21 minutes to report.
          // Inline has one bound, the in-process model budget, and it fails
          // fast and legibly.
          engine: 'inline',
        },
      },
      {
        id: agentNodeId,
        kind: 'agent',
        label: 'Agent',
        position: { x: 280, y: 0 },
        informUser: { mode: 'off' },
        config: {
          agentId,
          version,
          inputs: {},
          imageInputs: {},
          // Synthesis mode seeds a conversation via `triggerInput.messages`; link
          // it explicitly so the seeded thread reaches the agent (history is no
          // longer implicitly expanded from the trigger payload). Absent messages
          // (non-synthesis evals) resolve to nothing and are ignored.
          conversation: { kind: 'ref', nodeId: triggerId, path: 'messages' },
        },
      },
      {
        id: outputId,
        kind: 'output',
        label: 'Output',
        position: { x: 560, y: 0 },
        informUser: { mode: 'off' },
        // The run's result is the agent's whole output — bound explicitly (the
        // Output no longer implicitly forwards the live edge). The manual trigger
        // declares no output contract, so any shape the agent produces is fine.
        config: { source: { kind: 'ref', nodeId: agentNodeId, path: '' } },
      },
    ],
    edges: [
      { id: nodeId('edge-trigger-agent'), source: triggerId, target: agentNodeId, condition: null },
      { id: nodeId('edge-agent-output'), source: agentNodeId, target: outputId, condition: null },
    ],
  }
}

/**
 * Order-insensitive structural equality for two wrapper graphs.
 *
 * A stored graph has been through JSON and zod, either of which may reorder or
 * drop-and-default keys relative to the object the builder just returned, so a
 * plain `JSON.stringify` comparison would report drift on every call. Sorting
 * keys at every level compares what the graph MEANS rather than how it happens
 * to be serialized.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` never survives a JSON round-trip, so an explicitly-undefined
    // key on the fresh side must not read as drift against an absent one.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

/**
 * Ensure the hidden wrapper workflow for `agentId` exists and is CURRENT,
 * returning its id and latest version id. Idempotent: created once (cached by
 * {@link evalWrapperName}), reused thereafter. The wrapper floats to the
 * agent's latest version through the agent node, so it needs no re-publishing
 * when the agent itself changes.
 *
 * It DOES need re-publishing when the wrapper's own shape changes, and that is
 * the subtle part. A cached wrapper is a frozen copy of whatever
 * `buildAgentWrapperGraph` emitted the day it was first evaluated, so a fix to
 * the builder reaches new agents only — every agent already evaluated keeps the
 * old graph forever. That is not hypothetical: wrappers created before Output
 * nodes required an explicit `config.source` kept an unbound Output, and every
 * eval against them failed at run start with "Output node … has no bound
 * value". Comparing structurally and republishing on drift heals those in place
 * and makes the next builder change propagate on its own.
 */
export async function ensureAgentEvalWrapper(
  db: WfDb,
  input: { agentId: string; createdBy?: string },
): Promise<{ workflowId: string; workflowVersionId: string }> {
  const name = evalWrapperName(input.agentId)
  const graph = buildAgentWrapperGraph(input.agentId)
  const existing = await findWorkflowByName(db, name)
  if (existing) {
    const versionId = await getLatestVersionId(db, existing.id)
    if (versionId) {
      const stored = await getVersionGraph(db, versionId)
      if (stored && stableStringify(stored.graph) === stableStringify(graph)) {
        return { workflowId: existing.id, workflowVersionId: versionId }
      }
      // Stale (or unreadable) — publish the current shape as a new version and
      // run against that. History is preserved, so a past eval result still
      // resolves the exact graph it was produced by.
      const published = await saveVersion(db, {
        workflowId: existing.id,
        graph,
        changeNote: 'Regenerated eval wrapper (builder shape changed).',
        publishedBy: input.createdBy,
      })
      return { workflowId: existing.id, workflowVersionId: published.versionId }
    }
    // Row exists but somehow has no version — fall through and recreate cleanly
    // under a fresh id (the orphaned row is harmless; it's hidden and unused).
  }
  const created = await createWorkflow(db, {
    name,
    description: `Auto-generated eval wrapper for agent ${input.agentId}.`,
    hidden: true,
    createdBy: input.createdBy,
    graph,
  })
  return {
    workflowId: created.workflowId,
    workflowVersionId: created.versionId,
  }
}

/**
 * Resolve an eval set's target to the concrete `workflowVersionId` + the
 * trigger kind to start it under. Agent targets run their manual wrapper;
 * workflow targets run their latest version under the set's trigger kind.
 */
export async function resolveEvalTarget(
  db: WfDb,
  target: { kind: 'agent' | 'workflow'; id: string },
  setTriggerKind: string,
  opts?: { createdBy?: string },
): Promise<{ workflowVersionId: string; triggerKind: string }> {
  if (target.kind === 'agent') {
    const { workflowVersionId } = await ensureAgentEvalWrapper(db, {
      agentId: target.id,
      createdBy: opts?.createdBy,
    })
    return { workflowVersionId, triggerKind: MANUAL_TRIGGER_KIND }
  }
  const workflowVersionId = await getLatestVersionId(db, target.id)
  if (!workflowVersionId) {
    throw new Error(
      `Workflow target ${target.id} has no published version to eval against.`,
    )
  }
  return { workflowVersionId, triggerKind: setTriggerKind }
}
