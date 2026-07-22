import { and, desc, eq, inArray } from 'drizzle-orm'

import {
  workflowGraphShapeSchema,
  type WorkflowGraph,
} from '../../engine/graph'
import type { WfDb } from '../client'
import {
  wfRun,
  wfRunStep,
  wfWorkflow,
  wfWorkflowAssignment,
  wfWorkflowDraft,
  wfWorkflowVersion,
} from '../schema'
import { createVersionedEntity } from '../versioned-entity'

import { agentIdsInGraph } from './authoring-graph'
import { pickDefined } from './shared'

// Data-access for the authoring domain: workflows, agents, their shared
// version/draft lifecycle, run-manifest resolution, and trigger assignments.
// Pure functions over a `WfDb` handle — no auth, no tenancy (one global set).

// ---------------------------------------------------------------------------
// Workflows + versions + drafts
// ---------------------------------------------------------------------------

export async function listWorkflows(
  db: WfDb,
  opts?: { includeArchived?: boolean },
) {
  return await db
    .select()
    .from(wfWorkflow)
    .where(
      // Hidden workflows (eval wrappers) are machinery, not authored content.
      // Archived workflows are retired and drop off the list unless asked for.
      opts?.includeArchived
        ? eq(wfWorkflow.hidden, false)
        : and(eq(wfWorkflow.hidden, false), eq(wfWorkflow.archived, false)),
    )
    .orderBy(desc(wfWorkflow.createdAt))
}

/**
 * Find a hidden workflow by exact name — the lookup behind the agent-eval
 * wrapper cache. Returns the id, or null. Unlike {@link listWorkflows} this does
 * not filter out hidden rows (the wrapper it looks for IS hidden).
 */
export async function findWorkflowByName(
  db: WfDb,
  name: string,
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: wfWorkflow.id })
    .from(wfWorkflow)
    .where(eq(wfWorkflow.name, name))
    .limit(1)
  return row ?? null
}

// The shared version/draft lifecycle (seed, publish, draft sync). The entity
// row (name/hidden/archived) is created here; everything versioned goes through
// the factory so workflows and agents can't drift. See `versioned-entity.ts`.
const workflowVersions = createVersionedEntity<
  WorkflowGraph,
  typeof wfWorkflowVersion.$inferSelect
>({
  versionTable: wfWorkflowVersion,
  draftTable: wfWorkflowDraft,
  versionOwnerCol: wfWorkflowVersion.workflowId,
  versionNumberCol: wfWorkflowVersion.versionNumber,
  draftOwnerCol: wfWorkflowDraft.workflowId,
  ownerKey: 'workflowId',
  payloadKey: 'graph',
})

export async function createWorkflow(
  db: WfDb,
  input: {
    name: string
    description?: string
    createdBy?: string
    graph: WorkflowGraph
    /** Keep this workflow out of the Workflows list (eval-wrapper machinery). */
    hidden?: boolean
  },
) {
  const workflowId = crypto.randomUUID()
  await db.insert(wfWorkflow).values({
    id: workflowId,
    name: input.name,
    description: input.description ?? null,
    hidden: input.hidden ?? false,
    createdBy: input.createdBy ?? null,
  })
  // Seed version 1 + a matching draft so the editor opens on a valid graph.
  const { versionId } = await workflowVersions.seed(db, {
    ownerId: workflowId,
    payload: input.graph,
    createdBy: input.createdBy,
  })
  return { workflowId, versionId }
}

/**
 * Delete a workflow and everything hanging off it — its versions, draft,
 * trigger assignments, and the runs (+ steps) recorded against those versions.
 * The wf_* tables carry no FK constraints, so this does the cascade by hand.
 * Used by the seed's `--replace` path to drop a workflow before recreating it.
 */
export async function deleteWorkflow(db: WfDb, workflowId: string) {
  const versions = await db
    .select({ id: wfWorkflowVersion.id })
    .from(wfWorkflowVersion)
    .where(eq(wfWorkflowVersion.workflowId, workflowId))
  const versionIds = versions.map((v) => v.id)
  if (versionIds.length > 0) {
    const runs = await db
      .select({ id: wfRun.id })
      .from(wfRun)
      .where(inArray(wfRun.workflowVersionId, versionIds))
    const runIds = runs.map((r) => r.id)
    if (runIds.length > 0) {
      await db.delete(wfRunStep).where(inArray(wfRunStep.runId, runIds))
      await db.delete(wfRun).where(inArray(wfRun.id, runIds))
    }
  }
  await db
    .delete(wfWorkflowVersion)
    .where(eq(wfWorkflowVersion.workflowId, workflowId))
  await db
    .delete(wfWorkflowDraft)
    .where(eq(wfWorkflowDraft.workflowId, workflowId))
  await db
    .delete(wfWorkflowAssignment)
    .where(eq(wfWorkflowAssignment.workflowId, workflowId))
  await db.delete(wfWorkflow).where(eq(wfWorkflow.id, workflowId))
}

export function latestVersion(db: WfDb, workflowId: string) {
  return workflowVersions.latest(db, workflowId)
}

/** The editor's load shape: the workflow, its draft (if any), latest version. */
/**
 * Cheap existence check — a single indexed `SELECT id LIMIT 1`, for guards that
 * only need a boolean and would otherwise pay `getWorkflow`'s 3-query entity
 * load (workflow + draft + latest version).
 */
export async function workflowExists(
  db: WfDb,
  workflowId: string,
): Promise<boolean> {
  const row = (
    await db
      .select({ id: wfWorkflow.id })
      .from(wfWorkflow)
      .where(eq(wfWorkflow.id, workflowId))
      .limit(1)
  )[0]
  return row !== undefined
}

export async function getWorkflow(db: WfDb, workflowId: string) {
  const workflow = (
    await db
      .select()
      .from(wfWorkflow)
      .where(eq(wfWorkflow.id, workflowId))
      .limit(1)
  )[0]
  if (!workflow) {
    return null
  }
  const draft = (
    await db
      .select()
      .from(wfWorkflowDraft)
      .where(eq(wfWorkflowDraft.workflowId, workflowId))
      .limit(1)
  )[0]
  const currentVersion = await latestVersion(db, workflowId)
  return {
    workflow,
    draft: draft ?? null,
    currentVersion: currentVersion ?? null,
  }
}

export async function updateDraft(
  db: WfDb,
  input: { workflowId: string; graph: WorkflowGraph; lastEditedBy?: string },
) {
  await workflowVersions.updateDraft(db, {
    ownerId: input.workflowId,
    payload: input.graph,
    lastEditedBy: input.lastEditedBy,
  })
}

/** Snapshot a graph into a new immutable version (the editor's "publish"). */
export async function saveVersion(
  db: WfDb,
  input: {
    workflowId: string
    graph: WorkflowGraph
    changeNote?: string
    /** The AI summary, when the publish dialog already had it (else filled later). */
    aiSummaryShort?: string
    aiSummaryLong?: string
    publishedBy?: string
  },
) {
  return await workflowVersions.publish(db, {
    ownerId: input.workflowId,
    payload: input.graph,
    publishedBy: input.publishedBy,
    changeNote: input.changeNote,
    versionExtra: {
      aiSummaryShort: input.aiSummaryShort ?? null,
      aiSummaryLong: input.aiSummaryLong ?? null,
    },
  })
}

/**
 * Write the AI change summary onto a version after the fact — used when a
 * version is published before its summary was ready, and the host generates it
 * in the background (e.g. via `waitUntil`).
 */
export async function setVersionAiSummary(
  db: WfDb,
  input: { versionId: string; short: string; long: string },
) {
  await db
    .update(wfWorkflowVersion)
    .set({ aiSummaryShort: input.short, aiSummaryLong: input.long })
    .where(eq(wfWorkflowVersion.id, input.versionId))
}

// The single boundary where a stored graph JSON column becomes a typed
// `WorkflowGraph`. Uses the lenient *shape* schema (the same one `saveVersion` /
// `updateDraft` validate against) — the strict runtime gate still runs when a
// run actually starts — so drafts-with-issues round-trip, but a structurally
// broken column is caught here instead of silently blind-cast at each read site.
export function parseStoredGraph(value: unknown): WorkflowGraph {
  return workflowGraphShapeSchema.parse(value)
}

export async function getVersionGraph(
  db: WfDb,
  versionId: string,
): Promise<{
  graph: WorkflowGraph
  versionNumber: number
  workflowId: string
} | null> {
  const row = (
    await db
      .select()
      .from(wfWorkflowVersion)
      .where(eq(wfWorkflowVersion.id, versionId))
      .limit(1)
  )[0]
  return row
    ? {
        graph: parseStoredGraph(row.graph),
        versionNumber: row.versionNumber,
        workflowId: row.workflowId,
      }
    : null
}

export async function listVersions(db: WfDb, workflowId: string) {
  return await db
    .select({
      id: wfWorkflowVersion.id,
      versionNumber: wfWorkflowVersion.versionNumber,
      changeNote: wfWorkflowVersion.changeNote,
      aiSummaryShort: wfWorkflowVersion.aiSummaryShort,
      aiSummaryLong: wfWorkflowVersion.aiSummaryLong,
      createdAt: wfWorkflowVersion.createdAt,
      publishedAt: wfWorkflowVersion.publishedAt,
    })
    .from(wfWorkflowVersion)
    .where(eq(wfWorkflowVersion.workflowId, workflowId))
    .orderBy(desc(wfWorkflowVersion.versionNumber))
}

export async function updateWorkflow(
  db: WfDb,
  input: {
    workflowId: string
    name?: string
    description?: string | null
    archived?: boolean
  },
) {
  await db
    .update(wfWorkflow)
    .set({
      ...pickDefined(input, ['name', 'description', 'archived']),
      updatedAt: new Date(),
    })
    .where(eq(wfWorkflow.id, input.workflowId))
}

/** Reset the draft back to the latest published version's graph. */
export async function discardDraft(db: WfDb, input: { workflowId: string }) {
  await workflowVersions.discardDraft(db, input.workflowId)
}

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

// ---------------------------------------------------------------------------
// Assignments (trigger kind → workflow, one global mapping)
// ---------------------------------------------------------------------------

export async function assignWorkflow(
  db: WfDb,
  input: {
    triggerKind: string
    workflowId: string
    assignedBy?: string
  },
) {
  await db
    .insert(wfWorkflowAssignment)
    .values({
      id: crypto.randomUUID(),
      triggerKind: input.triggerKind,
      workflowId: input.workflowId,
      assignedBy: input.assignedBy ?? null,
    })
    .onConflictDoUpdate({
      target: wfWorkflowAssignment.triggerKind,
      set: {
        workflowId: input.workflowId,
        assignedBy: input.assignedBy ?? null,
      },
    })
}

/** Resolve the published version a trigger should run. */
export async function resolveAssignedVersion(
  db: WfDb,
  input: { triggerKind: string },
): Promise<{ workflowId: string; versionId: string } | null> {
  const assignment = (
    await db
      .select()
      .from(wfWorkflowAssignment)
      .where(eq(wfWorkflowAssignment.triggerKind, input.triggerKind))
      .limit(1)
  )[0]
  if (!assignment) {
    return null
  }
  // An archived workflow is retired: it never runs on its event, even if an
  // assignment still points at it. Treat it as if unassigned.
  const workflow = (
    await db
      .select({ archived: wfWorkflow.archived })
      .from(wfWorkflow)
      .where(eq(wfWorkflow.id, assignment.workflowId))
      .limit(1)
  )[0]
  if (!workflow || workflow.archived) {
    return null
  }
  const version = await latestVersion(db, assignment.workflowId)
  if (!version) {
    return null
  }
  return { workflowId: assignment.workflowId, versionId: version.id }
}
