import { eq, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'

import type { WorkflowGraph } from '../../engine/graph'
import type { WfDb } from '../client'
import { wfWorkflow, wfWorkflowDraft, wfWorkflowVersion } from '../schema'

import { agentIdsInGraph } from './authoring-graph'

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
// published version — in one place. All three reads are single queries: the
// per-workflow `latestVersion` lookup used to be an N+1 (one full-row fetch —
// including the large `graph` blob — per workflow), which dominated CPU on the
// agents list and the archive guard. Instead a correlated subquery pulls each
// workflow's latest-version graph in one round trip. Both
// `listWorkflowsReferencing*` build on this so the load/filter shape lives in
// exactly one function.
async function loadWorkflowReferenceGraphs(
  db: WfDb,
): Promise<{ id: string; name: string; graphs: WorkflowGraph[] }[]> {
  // Self-alias for the correlated subquery: "the max version_number for THIS
  // workflow", so the outer row is the latest published version of each. Built
  // with the query builder (not a raw `sql` fragment) so the aliased table is
  // declared as `wf_workflow_version AS wv_latest` in the subquery's FROM.
  const inner = alias(wfWorkflowVersion, 'wv_latest')
  const latestVersionNumber = db
    .select({ v: sql<number>`max(${inner.versionNumber})` })
    .from(inner)
    .where(eq(inner.workflowId, wfWorkflowVersion.workflowId))
  const [workflows, drafts, latestVersions] = await Promise.all([
    db.select({ id: wfWorkflow.id, name: wfWorkflow.name }).from(wfWorkflow),
    db
      .select({
        workflowId: wfWorkflowDraft.workflowId,
        graph: wfWorkflowDraft.graph,
      })
      .from(wfWorkflowDraft),
    db
      .select({
        workflowId: wfWorkflowVersion.workflowId,
        graph: wfWorkflowVersion.graph,
      })
      .from(wfWorkflowVersion)
      .where(eq(wfWorkflowVersion.versionNumber, latestVersionNumber)),
  ])
  const draftByWorkflow = new Map(drafts.map((d) => [d.workflowId, d.graph]))
  const latestByWorkflow = new Map(
    latestVersions.map((v) => [v.workflowId, v.graph]),
  )
  return workflows.map((wf) => ({
    id: wf.id,
    name: wf.name,
    graphs: [draftByWorkflow.get(wf.id), latestByWorkflow.get(wf.id)].filter(
      Boolean,
    ) as WorkflowGraph[],
  }))
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
