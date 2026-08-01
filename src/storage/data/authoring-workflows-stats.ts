import { and, eq, inArray, sql } from 'drizzle-orm'

import type { WorkflowGraph } from '../../engine/graph'
import type { WfDb } from '../client'
import { wfAgent, wfRun, wfWorkflowDraft, wfWorkflowVersion } from '../schema'

import { agentIdsInGraph } from './authoring-graph'
import { latestVersion, listWorkflows } from './authoring-workflows'

// The Workflows-list activity rollup: latest version, last edit, run counts, and
// the agents each workflow uses — three grouped aggregates + one agent lookup
// folded onto the `listWorkflows` rows. Kept apart from the workflow CRUD so the
// aggregation lives in one focused place.

/** An agent used by a workflow, with just enough to render its icon chip. */
export type WorkflowAgentRef = {
  id: string
  name: string
  icon: string | null
  color: string | null
}

/** Per-workflow activity for the list: latest version, last edit, run activity. */
export type WorkflowStats = {
  /** Highest published version number (a workflow always seeds v1). */
  latestVersionNumber: number | null
  /** Newest of workflow/version/draft edits — "last updated", epoch ms. */
  updatedAt: number | null
  /** Newest non-eval run's `createdAt`, epoch ms; null if never run. */
  lastRunAt: number | null
  /** Non-eval run count. */
  runCount: number
  /** Distinct agents referenced by the latest published version's graph. */
  agents: WorkflowAgentRef[]
}

/**
 * {@link listWorkflows} plus the per-workflow activity the Workflows list shows:
 * latest version number, last-updated time, last run, and total run count. Three
 * grouped aggregate queries (versions, drafts, runs) folded onto the rows — no
 * per-workflow N+1. Timestamps come back from `max()` as unix SECONDS (the
 * columns are `timestamp` mode), so they're scaled to epoch ms here.
 */
export async function listWorkflowsWithStats(
  db: WfDb,
  opts?: { includeArchived?: boolean },
): Promise<
  Array<
    Omit<Awaited<ReturnType<typeof listWorkflows>>[number], 'updatedAt'> &
      WorkflowStats
  >
> {
  const workflows = await listWorkflows(db, opts)
  if (workflows.length === 0) return []
  const ids = workflows.map((w) => w.id)

  const [versionRows, draftRows, runRows] = await Promise.all([
    db
      .select({
        workflowId: wfWorkflowVersion.workflowId,
        latestVersionNumber: sql<number>`max(${wfWorkflowVersion.versionNumber})`,
        latestVersionAt: sql<
          number | null
        >`max(${wfWorkflowVersion.createdAt})`,
      })
      .from(wfWorkflowVersion)
      .where(inArray(wfWorkflowVersion.workflowId, ids))
      .groupBy(wfWorkflowVersion.workflowId),
    db
      .select({
        workflowId: wfWorkflowDraft.workflowId,
        updatedAt: sql<number | null>`${wfWorkflowDraft.updatedAt}`,
      })
      .from(wfWorkflowDraft)
      .where(inArray(wfWorkflowDraft.workflowId, ids)),
    db
      .select({
        workflowId: wfWorkflowVersion.workflowId,
        runCount: sql<number>`count(*)`,
        lastRunAt: sql<number | null>`max(${wfRun.createdAt})`,
      })
      .from(wfRun)
      .innerJoin(
        wfWorkflowVersion,
        eq(wfRun.workflowVersionId, wfWorkflowVersion.id),
      )
      .where(
        and(eq(wfRun.isEval, false), inArray(wfWorkflowVersion.workflowId, ids)),
      )
      .groupBy(wfWorkflowVersion.workflowId),
  ])

  // Agents each workflow uses, pulled from its latest published version graph.
  // One `latestVersion` per workflow (the list is small), then a single lookup
  // resolves every referenced agent's display metadata.
  const latestGraphs = await Promise.all(
    workflows.map((w) => latestVersion(db, w.id)),
  )
  const agentIdsByWf = new Map<string, string[]>()
  const referencedAgentIds = new Set<string>()
  for (const [i, w] of workflows.entries()) {
    // `graph` is stored JSON (loosely typed); the walk only reads node shapes.
    const graph = latestGraphs[i]?.graph as WorkflowGraph | undefined
    const agentIds = graph ? agentIdsInGraph(graph) : []
    agentIdsByWf.set(w.id, agentIds)
    for (const id of agentIds) referencedAgentIds.add(id)
  }
  const agentRows =
    referencedAgentIds.size > 0
      ? await db
          .select({
            id: wfAgent.id,
            name: wfAgent.name,
            icon: wfAgent.icon,
            color: wfAgent.color,
          })
          .from(wfAgent)
          .where(inArray(wfAgent.id, [...referencedAgentIds]))
      : []
  const agentById = new Map(agentRows.map((a) => [a.id, a]))

  const secondsToMs = (s: number | null | undefined) =>
    s == null ? null : s * 1000
  const versionByWf = new Map(versionRows.map((r) => [r.workflowId, r]))
  const draftAtByWf = new Map(
    draftRows.map((r) => [r.workflowId, secondsToMs(r.updatedAt)]),
  )
  const runByWf = new Map(runRows.map((r) => [r.workflowId, r]))

  return workflows.map((w) => {
    const version = versionByWf.get(w.id)
    const run = runByWf.get(w.id)
    // "Last updated" = the freshest signal across the workflow row, its latest
    // version, and its draft — whichever the human touched most recently.
    const updatedAt = Math.max(
      w.updatedAt?.getTime() ?? 0,
      w.createdAt.getTime(),
      secondsToMs(version?.latestVersionAt) ?? 0,
      draftAtByWf.get(w.id) ?? 0,
    )
    const agents = (agentIdsByWf.get(w.id) ?? [])
      .map((id) => agentById.get(id))
      .filter((a): a is WorkflowAgentRef => a != null)
    return {
      ...w,
      latestVersionNumber: version?.latestVersionNumber ?? null,
      updatedAt: updatedAt || null,
      lastRunAt: secondsToMs(run?.lastRunAt),
      runCount: Number(run?.runCount ?? 0),
      agents,
    }
  })
}
