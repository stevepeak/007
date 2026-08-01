import type { WorkflowGraph } from '../../engine/graph'
import type { WfDb } from '../client'
import { wfWorkflow, wfWorkflowDraft } from '../schema'

import { agentIdsInGraph } from './authoring-graph'
import { latestVersion } from './authoring-workflows'

// Which workflows reference which agents, read from each workflow's "live"
// graphs (its draft + latest published version). Powers the agent archive guard
// and the agents-list usage column. The load/filter shape lives in one private
// helper the public listers build on.

// ---------------------------------------------------------------------------
// Workflow reference listing
// ---------------------------------------------------------------------------

/**
 * The workflows that reference an agent in their draft OR their latest published
 * version — the "live" references. Historical published versions are ignored, so
 * this is the set that would break if the agent were archived. Powers both the
 * archive guard (block + list) and the publish-warning count. Workflow agent
 * nodes float to the agent's latest published version, so publishing updates
 * every referencing workflow immediately.
 */
// Load every workflow's "live" reference graphs — its draft plus its latest
// published version — in one place. Drafts are fetched in a single query (one
// row per workflow) rather than per-workflow, so only the per-workflow
// `latestVersion` lookup remains. Both `listWorkflowsReferencing*` build on this
// so the load/filter shape lives in exactly one function.
async function loadWorkflowReferenceGraphs(
  db: WfDb,
): Promise<{ id: string; name: string; graphs: WorkflowGraph[] }[]> {
  const workflows = await db
    .select({ id: wfWorkflow.id, name: wfWorkflow.name })
    .from(wfWorkflow)
  const drafts = await db
    .select({
      workflowId: wfWorkflowDraft.workflowId,
      graph: wfWorkflowDraft.graph,
    })
    .from(wfWorkflowDraft)
  const draftByWorkflow = new Map(drafts.map((d) => [d.workflowId, d.graph]))
  const out: { id: string; name: string; graphs: WorkflowGraph[] }[] = []
  for (const wf of workflows) {
    const version = await latestVersion(db, wf.id)
    const graphs = [draftByWorkflow.get(wf.id), version?.graph].filter(
      Boolean,
    ) as WorkflowGraph[]
    out.push({ id: wf.id, name: wf.name, graphs })
  }
  return out
}

export async function listWorkflowsReferencingAgent(
  db: WfDb,
  input: { agentId: string },
): Promise<{ id: string; name: string }[]> {
  const all = await loadWorkflowReferenceGraphs(db)
  return all
    .filter((wf) =>
      wf.graphs.some((g) => agentIdsInGraph(g).includes(input.agentId)),
    )
    .map((wf) => ({ id: wf.id, name: wf.name }))
}

// The inverse of {@link listWorkflowsReferencingAgent} for every agent at once:
// one pass over all workflow graphs building agentId → referencing workflows.
// Lets the agents list show each agent's workflow usage without an N+1 scan.
export async function listWorkflowsReferencingAllAgents(
  db: WfDb,
): Promise<Map<string, { id: string; name: string }[]>> {
  const all = await loadWorkflowReferenceGraphs(db)
  const byAgent = new Map<string, { id: string; name: string }[]>()
  for (const wf of all) {
    const agentIds = new Set<string>()
    for (const g of wf.graphs) {
      for (const id of agentIdsInGraph(g)) agentIds.add(id)
    }
    for (const id of agentIds) {
      const list = byAgent.get(id) ?? []
      list.push({ id: wf.id, name: wf.name })
      byAgent.set(id, list)
    }
  }
  return byAgent
}

/** How many workflows reference an agent (draft or latest published version). */
export async function countWorkflowsReferencingAgent(
  db: WfDb,
  input: { agentId: string },
): Promise<number> {
  return (await listWorkflowsReferencingAgent(db, input)).length
}
