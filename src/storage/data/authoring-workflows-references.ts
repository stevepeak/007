import { and, eq } from 'drizzle-orm'

import type { WorkflowGraph } from '../../engine/graph'
import type { WfDb } from '../client'
import { wfWorkflow, wfWorkflowDraft } from '../schema'

import { agentIdsInGraph, allNodes } from './authoring-graph'
import { latestVersionGraphs } from './authoring-workflows'

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
// published version — in one place. All three reads are single queries; the
// latest-version fan-out in particular goes through `latestVersionGraphs`, which
// exists precisely so this doesn't regress into a per-workflow N+1 (see its doc
// comment). Both `listWorkflowsReferencing*` build on this so the load/filter
// shape lives in exactly one function.
//
// Archived workflows are excluded: a retired workflow never runs, so the agents
// its graph names are not really in use. Counting them would inflate the
// agents-list usage column and — worse — let a dead workflow block archiving an
// agent nothing live still calls. Drafts and versions of archived workflows drop
// out with them, since the map below only walks the workflows this query keeps.
//
// Hidden workflows are excluded for the same reasons. An eval wrapper IS a row
// here, and its graph is an agent node pointing at the agent it grades — so an
// agent with an eval set and no authored graph would read as "1 workflow" (a
// workflow the Workflows list deliberately hides, leaving nothing to click) and
// could never be archived, because a wrapper is regenerated from its eval set
// and there is nothing to disconnect. Usage means AUTHORED usage.
async function loadWorkflowReferenceGraphs(db: WfDb): Promise<
  {
    id: string
    name: string
    /** The latest published graph — what runs today. */
    published: WorkflowGraph | undefined
    /** Draft + published, the "live" pair. */
    graphs: WorkflowGraph[]
  }[]
> {
  const [workflows, drafts, latestByWorkflow] = await Promise.all([
    db
      .select({ id: wfWorkflow.id, name: wfWorkflow.name })
      .from(wfWorkflow)
      .where(
        and(eq(wfWorkflow.archived, false), eq(wfWorkflow.hidden, false)),
      ),
    db
      .select({
        workflowId: wfWorkflowDraft.workflowId,
        graph: wfWorkflowDraft.graph,
      })
      .from(wfWorkflowDraft),
    latestVersionGraphs(db),
  ])
  const draftByWorkflow = new Map(drafts.map((d) => [d.workflowId, d.graph]))
  return workflows.map((wf) => {
    const published = latestByWorkflow.get(wf.id)?.graph as
      | WorkflowGraph
      | undefined
    return {
      id: wf.id,
      name: wf.name,
      published,
      graphs: [draftByWorkflow.get(wf.id), published].filter(
        Boolean,
      ) as WorkflowGraph[],
    }
  })
}

export async function listWorkflowsReferencingAgent(
  db: WfDb,
  input: { agentId: string },
): Promise<{ id: string; name: string }[]> {
  const all = await loadWorkflowReferenceGraphs(db)
  return all
    .filter((wf) => {
      return wf.graphs.some((g) => agentIdsInGraph(g).includes(input.agentId))
    })
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

/** A workflow that points at an agent, and how. */
export type AgentBlastRadiusRef = {
  workflowId: string
  workflowName: string
  /** Labels of the published nodes that point at the agent, subgraphs included. */
  nodes: string[]
  /** Pinned versions in use, when any of those nodes pins one. */
  pinnedVersions: number[]
}

/**
 * What publishing an agent changes, from the same one-pass load as the other
 * listers: published graphs with an unpinned node (they run the new version
 * next), those that only pin a version (they don't), and workflows that name
 * the agent only in an unpublished draft (not live).
 */
export async function listAgentBlastRadius(
  db: WfDb,
  input: { agentId: string },
): Promise<{
  floating: AgentBlastRadiusRef[]
  pinned: AgentBlastRadiusRef[]
  draftOnly: { workflowId: string; workflowName: string }[]
}> {
  const out = {
    floating: [] as AgentBlastRadiusRef[],
    pinned: [] as AgentBlastRadiusRef[],
    draftOnly: [] as { workflowId: string; workflowName: string }[],
  }
  for (const wf of await loadWorkflowReferenceGraphs(db)) {
    if (!wf.graphs.some((g) => agentIdsInGraph(g).includes(input.agentId))) {
      continue
    }
    const nodes = wf.published
      ? [...allNodes(wf.published)].filter((n) => {
          return n.kind === 'agent' && n.config.agentId === input.agentId
        })
      : []
    if (nodes.length === 0) {
      out.draftOnly.push({ workflowId: wf.id, workflowName: wf.name })
      continue
    }
    const versions = nodes.map((n) => {
      return n.kind === 'agent' ? n.config.version : undefined
    })
    const ref: AgentBlastRadiusRef = {
      workflowId: wf.id,
      workflowName: wf.name,
      nodes: nodes.map((n) => n.label),
      pinnedVersions: [
        ...new Set(versions.filter((v): v is number => typeof v === 'number')),
      ],
    }
    const floats = versions.some((v) => typeof v !== 'number')
    ;(floats ? out.floating : out.pinned).push(ref)
  }
  return out
}
