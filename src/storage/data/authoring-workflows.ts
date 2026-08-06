import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'

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
  typeof wfWorkflowVersion.$inferSelect,
  typeof wfWorkflow.$inferSelect,
  typeof wfWorkflowDraft.$inferSelect
>({
  entityTable: wfWorkflow,
  entityIdCol: wfWorkflow.id,
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
    /** Stable cross-environment identity (see `wfWorkflow.slug`); import sets it. */
    slug?: string
    /**
     * Explicit row id. Import pre-assigns ids so a graph's sub-workflow refs can
     * be resolved to slugs→ids before any row is written (breaking the create
     * order cycle when workflows reference each other). Defaults to a fresh UUID.
     */
    id?: string
    description?: string
    createdBy?: string
    graph: WorkflowGraph
    /** Keep this workflow out of the Workflows list (eval-wrapper machinery). */
    hidden?: boolean
  },
) {
  const workflowId = input.id ?? crypto.randomUUID()
  await db.insert(wfWorkflow).values({
    id: workflowId,
    slug: input.slug ?? null,
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

/** One workflow's latest published version, as {@link latestVersionGraphs} returns it. */
export type LatestVersionGraph = {
  id: string
  versionNumber: number
  /** The stored JSON column — run it through {@link parseStoredGraph} to type it. */
  graph: unknown
  createdAt: Date
}

/**
 * Every workflow's latest published version — id, number, graph, and timestamp —
 * in ONE query, keyed by workflow id. Workflows with no versions are absent.
 *
 * This exists because the obvious shape (`latestVersion` per workflow) is an
 * N+1 that fetches a full `graph` blob per round trip, and it bit us twice: the
 * agents list and the workflows list each grew their own copy, and each showed
 * up in Sentry as the same repeating `wf_workflow_version` select. A correlated
 * subquery ("the max version_number for THIS workflow") gets the same rows in
 * one trip, riding the existing `(workflow_id, version_number)` unique index.
 * Keep new callers on this instead of looping — that's the whole point of it
 * living here rather than inside either caller.
 *
 * `ids` scopes the read to a known set (pass the ids you already listed);
 * omit it for every workflow in the table.
 */
export async function latestVersionGraphs(
  db: WfDb,
  ids?: string[],
): Promise<Map<string, LatestVersionGraph>> {
  if (ids?.length === 0) return new Map()
  // Self-alias for the correlated subquery, so the aliased table is declared as
  // `wf_workflow_version AS wv_latest` in the subquery's FROM and the outer
  // reference to `wf_workflow_version` stays unambiguous.
  const inner = alias(wfWorkflowVersion, 'wv_latest')
  const latestVersionNumber = db
    .select({ v: sql<number>`max(${inner.versionNumber})` })
    .from(inner)
    .where(eq(inner.workflowId, wfWorkflowVersion.workflowId))
  const isLatest = eq(wfWorkflowVersion.versionNumber, latestVersionNumber)
  const rows = await db
    .select({
      workflowId: wfWorkflowVersion.workflowId,
      id: wfWorkflowVersion.id,
      versionNumber: wfWorkflowVersion.versionNumber,
      graph: wfWorkflowVersion.graph,
      createdAt: wfWorkflowVersion.createdAt,
    })
    .from(wfWorkflowVersion)
    .where(
      ids ? and(isLatest, inArray(wfWorkflowVersion.workflowId, ids)) : isLatest,
    )
  return new Map(
    rows.map((r) => [
      r.workflowId,
      {
        id: r.id,
        versionNumber: r.versionNumber,
        graph: r.graph,
        createdAt: r.createdAt,
      },
    ]),
  )
}

/** The editor's load shape: the workflow, its draft (if any), latest version. */
/**
 * Cheap existence check — a single indexed `SELECT id LIMIT 1`, for guards that
 * only need a boolean and would otherwise pay `getWorkflow`'s 3-query entity
 * load (workflow + draft + latest version).
 */
export function workflowExists(db: WfDb, workflowId: string): Promise<boolean> {
  return workflowVersions.exists(db, workflowId)
}

export async function getWorkflow(db: WfDb, workflowId: string) {
  const loaded = await workflowVersions.load(db, workflowId)
  if (!loaded) return null
  return {
    workflow: loaded.entity,
    draft: loaded.draft,
    currentVersion: loaded.currentVersion,
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
  await workflowVersions.updateMeta(
    db,
    input.workflowId,
    pickDefined(input, ['name', 'description', 'archived']),
  )
}

/** Reset the draft back to the latest published version's graph. */
export async function discardDraft(db: WfDb, input: { workflowId: string }) {
  await workflowVersions.discardDraft(db, input.workflowId)
}

