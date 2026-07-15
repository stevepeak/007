import type { WorkflowGraph } from '../engine/graph'
import { MANUAL_TRIGGER_KIND } from '../engine/trigger-registry'
import type { WfDb } from '../storage/client'
import {
  createWorkflow,
  findWorkflowByName,
  getLatestVersionId,
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

export function evalWrapperName(agentId: string): string {
  return `${EVAL_WRAPPER_NAME_PREFIX}${agentId}`
}

/**
 * The minimal runnable graph for an agent eval: a manual trigger wired through
 * an agent node (pointing at `agentId`, floating to latest) into an Output. Pure
 * — no db, no side effects; ids are fresh per call (they're internal to the
 * frozen version, never referenced elsewhere).
 */
export function buildAgentWrapperGraph(agentId: string): WorkflowGraph {
  const triggerId = crypto.randomUUID()
  const agentNodeId = crypto.randomUUID()
  const outputId = crypto.randomUUID()
  return {
    version: 1,
    nodes: [
      {
        id: triggerId,
        kind: 'trigger',
        label: 'Manual start',
        position: { x: 0, y: 0 },
        config: { triggerKind: MANUAL_TRIGGER_KIND },
      },
      {
        id: agentNodeId,
        kind: 'agent',
        label: 'Agent',
        position: { x: 280, y: 0 },
        config: { agentId, inputs: {}, imageInputs: {} },
      },
      {
        id: outputId,
        kind: 'output',
        label: 'Output',
        position: { x: 560, y: 0 },
        config: {},
      },
    ],
    edges: [
      { id: crypto.randomUUID(), source: triggerId, target: agentNodeId, condition: null },
      { id: crypto.randomUUID(), source: agentNodeId, target: outputId, condition: null },
    ],
  }
}

/**
 * Ensure the hidden wrapper workflow for `agentId` exists, returning its id and
 * latest version id. Idempotent: created once (cached by {@link evalWrapperName}),
 * reused thereafter. The wrapper floats to the agent's latest version through the
 * agent node, so it never needs re-publishing when the agent changes.
 */
export async function ensureAgentEvalWrapper(
  db: WfDb,
  input: { agentId: string; createdBy?: string },
): Promise<{ workflowId: string; workflowVersionId: string }> {
  const name = evalWrapperName(input.agentId)
  const existing = await findWorkflowByName(db, name)
  if (existing) {
    const versionId = await getLatestVersionId(db, existing.id)
    if (versionId) {
      return { workflowId: existing.id, workflowVersionId: versionId }
    }
    // Row exists but somehow has no version — fall through and recreate cleanly
    // under a fresh id (the orphaned row is harmless; it's hidden and unused).
  }
  const created = await createWorkflow(db, {
    name,
    description: `Auto-generated eval wrapper for agent ${input.agentId}.`,
    hidden: true,
    createdBy: input.createdBy,
    graph: buildAgentWrapperGraph(input.agentId),
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
