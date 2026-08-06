import { and, eq, inArray, sql } from 'drizzle-orm'

import type { WorkflowGraph } from '../../engine/graph'
import type { WfDb } from '../client'
import { wfAgent, wfRun, wfWorkflowDraft, wfWorkflowVersion } from '../schema'

import { agentIdsInGraph } from './authoring-graph'
import { latestVersionGraphs, listWorkflows } from './authoring-workflows'

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
 * latest version number, last-updated time, last run, and total run count.
 *
 * Fixed query count regardless of how many workflows exist: the list, then three
 * batched reads (latest versions, drafts, runs), then one agent lookup. Note the
 * two timestamp conventions in play — the draft/run aggregates go through raw
 * `max()` fragments, which bypass the column's `timestamp` mode and come back as
 * unix SECONDS (hence `secondsToMs`), while `latestVersionGraphs` reads the typed
 * column and hands back a `Date`.
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

  // The latest version doubles as the version aggregate: versions only ever
  // count up, so the newest one's `createdAt` IS `max(created_at)`.
  const [latestByWf, draftRows, runRows] = await Promise.all([
    latestVersionGraphs(db, ids),
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

  // Agents each workflow uses, walked out of the latest published version graphs
  // already in hand; one more lookup resolves every referenced agent's display
  // metadata.
  const agentIdsByWf = new Map<string, string[]>()
  const referencedAgentIds = new Set<string>()
  for (const w of workflows) {
    // `graph` is stored JSON (loosely typed); the walk only reads node shapes.
    const graph = latestByWf.get(w.id)?.graph as WorkflowGraph | undefined
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
  const draftAtByWf = new Map(
    draftRows.map((r) => [r.workflowId, secondsToMs(r.updatedAt)]),
  )
  const runByWf = new Map(runRows.map((r) => [r.workflowId, r]))

  return workflows.map((w) => {
    const version = latestByWf.get(w.id)
    const run = runByWf.get(w.id)
    // "Last updated" = the freshest signal across the workflow row, its latest
    // version, and its draft — whichever the human touched most recently.
    const updatedAt = Math.max(
      w.updatedAt?.getTime() ?? 0,
      w.createdAt.getTime(),
      version?.createdAt.getTime() ?? 0,
      draftAtByWf.get(w.id) ?? 0,
    )
    const agents = (agentIdsByWf.get(w.id) ?? [])
      .map((id) => agentById.get(id))
      .filter((a): a is WorkflowAgentRef => a != null)
    return {
      ...w,
      latestVersionNumber: version?.versionNumber ?? null,
      updatedAt: updatedAt || null,
      lastRunAt: secondsToMs(run?.lastRunAt),
      runCount: Number(run?.runCount ?? 0),
      agents,
    }
  })
}
