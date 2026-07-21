import { and, desc, eq, inArray } from 'drizzle-orm'

import {
  agentConfigSchema,
  type AgentConfig,
  type WfRunManifestEntry,
  type WorkflowGraph,
} from '../../engine/graph'
import type { WfDb } from '../client'
import {
  wfAgent,
  wfAgentDraft,
  wfAgentVersion,
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

export async function getVersionGraph(
  db: WfDb,
  versionId: string,
): Promise<{
  graph: unknown
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
        graph: row.graph,
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
// Run manifest resolution
// ---------------------------------------------------------------------------

// Every node in a graph, INCLUDING those nested inside iteration subgraphs. An
// iteration node's subgraph runs as an inline graph once per item, and those
// per-item nodes resolve against the SAME flat run manifest — so an agent or a
// sub-workflow call living inside a subgraph must contribute to the manifest
// just as a top-level one does. (Iteration can't nest, but a subgraph may hold a
// `workflow` node, whose callee is resolved transitively by `resolveInto`.)
function* allNodes(
  graph: WorkflowGraph,
): Generator<WorkflowGraph['nodes'][number]> {
  for (const node of graph.nodes) {
    yield node
    if (node.kind === 'iteration') {
      yield* allNodes(node.config.subgraph)
    }
  }
}

// Distinct agent ids referenced by agent nodes in a graph (incl. subgraphs).
function agentIdsInGraph(graph: WorkflowGraph): string[] {
  const ids = new Set<string>()
  for (const node of allNodes(graph)) {
    if (node.kind === 'agent' && node.config.agentId) {
      ids.add(node.config.agentId)
    }
  }
  return [...ids]
}

// Distinct (agentId, version-pin) pairs referenced by agent nodes (incl. those
// inside iteration subgraphs). Two nodes pinning the same agent to different
// versions yield two pairs, so each gets its own manifest entry. `version` is
// `null` for float-to-latest nodes.
function agentPinsInGraph(
  graph: WorkflowGraph,
): { agentId: string; version: number | null }[] {
  const seen = new Map<string, { agentId: string; version: number | null }>()
  for (const node of allNodes(graph)) {
    if (node.kind === 'agent' && node.config.agentId) {
      const version = node.config.version ?? null
      const key = `${node.config.agentId}@${version ?? 'latest'}`
      if (!seen.has(key))
        seen.set(key, { agentId: node.config.agentId, version })
    }
  }
  return [...seen.values()]
}

// Distinct workflow ids called by workflow nodes in a graph (incl. subgraphs).
function workflowIdsInGraph(graph: WorkflowGraph): string[] {
  const ids = new Set<string>()
  for (const node of allNodes(graph)) {
    if (node.kind === 'workflow' && node.config.workflowId) {
      ids.add(node.config.workflowId)
    }
  }
  return [...ids]
}

// Hard cap on nested-workflow depth. A guard against pathological chains; real
// graphs never come close. Reference cycles are caught earlier (by `stack`), so
// this only bounds honest but absurdly deep call trees.
const MAX_WORKFLOW_DEPTH = 16

/**
 * Resolve every floating reference reachable from a graph — its agents AND the
 * workflows it calls, transitively — to their latest published versions, and
 * flatten them into one manifest frozen into `wf_run.manifest` at run start.
 * A called workflow's graph is frozen in whole (it runs inline as a subgraph);
 * its own agents and sub-workflows are resolved into the SAME flat manifest, so
 * nested nodes find their entries. Reference cycles (A calls B calls A) are a
 * hard error — inline execution would otherwise recurse forever.
 */
export async function resolveRunManifest(
  db: WfDb,
  graph: WorkflowGraph,
): Promise<WfRunManifestEntry[]> {
  const entries: WfRunManifestEntry[] = []
  // Dedup key is `agentId@pin` so the same agent pinned to different versions
  // by different nodes lands as several distinct entries.
  const seenAgentPins = new Set<string>()
  const seenWorkflows = new Set<string>()

  const resolveInto = async (
    g: WorkflowGraph,
    // The chain of workflow ids currently being resolved, for cycle detection.
    stack: string[],
  ): Promise<void> => {
    if (stack.length > MAX_WORKFLOW_DEPTH) {
      throw new Error(
        `Workflow nesting too deep (> ${MAX_WORKFLOW_DEPTH}): ${stack.join(' → ')}.`,
      )
    }
    for (const { agentId, version: pin } of agentPinsInGraph(g)) {
      const key = `${agentId}@${pin ?? 'latest'}`
      if (seenAgentPins.has(key)) {
        continue
      }
      seenAgentPins.add(key)
      // `null` pin floats to latest; a number resolves that exact version. A
      // pin pointing at a version that no longer exists resolves to nothing —
      // the node then fails at run time with a clear "not in manifest" error.
      const version =
        pin == null
          ? await latestAgentVersion(db, agentId)
          : await agentVersionByNumber(db, agentId, pin)
      if (!version) {
        continue
      }
      const agent = (
        await db
          .select({ name: wfAgent.name })
          .from(wfAgent)
          .where(eq(wfAgent.id, agentId))
          .limit(1)
      )[0]
      entries.push({
        kind: 'agent',
        id: agentId,
        pinnedVersion: pin,
        versionId: version.id,
        versionNumber: version.versionNumber,
        name: agent?.name ?? '',
        config: agentConfigSchema.parse(version.config),
      })
    }
    for (const workflowId of workflowIdsInGraph(g)) {
      if (stack.includes(workflowId)) {
        throw new Error(
          `Workflow reference cycle: ${[...stack, workflowId].join(' → ')}.`,
        )
      }
      if (seenWorkflows.has(workflowId)) {
        continue
      }
      seenWorkflows.add(workflowId)
      const version = await latestVersion(db, workflowId)
      if (!version) {
        continue
      }
      const workflow = (
        await db
          .select({ name: wfWorkflow.name })
          .from(wfWorkflow)
          .where(eq(wfWorkflow.id, workflowId))
          .limit(1)
      )[0]
      const calleeGraph = version.graph as WorkflowGraph
      entries.push({
        kind: 'workflow',
        id: workflowId,
        versionId: version.id,
        versionNumber: version.versionNumber,
        name: workflow?.name ?? '',
        graph: calleeGraph,
      })
      await resolveInto(calleeGraph, [...stack, workflowId])
    }
  }

  await resolveInto(graph, [])
  return entries
}

/**
 * The workflows that reference an agent in their draft OR their latest published
 * version — the "live" references. Historical published versions are ignored, so
 * this is the set that would break if the agent were archived. Powers both the
 * archive guard (block + list) and the publish-warning count. Workflow agent
 * nodes float to the agent's latest published version, so publishing updates
 * every referencing workflow immediately.
 */
export async function listWorkflowsReferencingAgent(
  db: WfDb,
  input: { agentId: string },
): Promise<{ id: string; name: string }[]> {
  const workflows = await db
    .select({ id: wfWorkflow.id, name: wfWorkflow.name })
    .from(wfWorkflow)
  const referencing: { id: string; name: string }[] = []
  for (const wf of workflows) {
    const draft = (
      await db
        .select({ graph: wfWorkflowDraft.graph })
        .from(wfWorkflowDraft)
        .where(eq(wfWorkflowDraft.workflowId, wf.id))
        .limit(1)
    )[0]
    const version = await latestVersion(db, wf.id)
    const graphs = [draft?.graph, version?.graph].filter(
      Boolean,
    ) as WorkflowGraph[]
    const referenced = graphs.some((g) =>
      agentIdsInGraph(g).includes(input.agentId),
    )
    if (referenced) {
      referencing.push({ id: wf.id, name: wf.name })
    }
  }
  return referencing
}

// The inverse of {@link listWorkflowsReferencingAgent} for every agent at once:
// one pass over all workflow graphs building agentId → referencing workflows.
// Lets the agents list show each agent's workflow usage without an N+1 scan.
export async function listWorkflowsReferencingAllAgents(
  db: WfDb,
): Promise<Map<string, { id: string; name: string }[]>> {
  const workflows = await db
    .select({ id: wfWorkflow.id, name: wfWorkflow.name })
    .from(wfWorkflow)
  const byAgent = new Map<string, { id: string; name: string }[]>()
  for (const wf of workflows) {
    const draft = (
      await db
        .select({ graph: wfWorkflowDraft.graph })
        .from(wfWorkflowDraft)
        .where(eq(wfWorkflowDraft.workflowId, wf.id))
        .limit(1)
    )[0]
    const version = await latestVersion(db, wf.id)
    const graphs = [draft?.graph, version?.graph].filter(
      Boolean,
    ) as WorkflowGraph[]
    const agentIds = new Set<string>()
    for (const g of graphs) {
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
// Agents + versions + drafts
// ---------------------------------------------------------------------------
//
// Same lifecycle as workflows. `config` is the versioned AgentConfig
// (model, prompt, tools, output contract); name/icon/color are display metadata
// on the entity, edited in place via `updateAgentMeta`.

export async function listAgents(db: WfDb) {
  // Archived agents drop out of the list (and, via the same hook, the workflow
  // node picker). getAgent stays unfiltered so an in-flight editor still loads.
  const agents = await db
    .select()
    .from(wfAgent)
    .where(eq(wfAgent.archived, false))
    .orderBy(desc(wfAgent.createdAt))
  if (agents.length === 0) {
    return []
  }
  // Attach each agent's latest published config so callers can expose its
  // prompt variables + output contract without an N+1 per-agent fetch. One
  // query, highest version-number first, first-seen-per-agent wins.
  const versions = await db
    .select()
    .from(wfAgentVersion)
    .where(
      inArray(
        wfAgentVersion.agentId,
        agents.map((a) => a.id),
      ),
    )
    .orderBy(desc(wfAgentVersion.versionNumber))
  const latestByAgent = new Map<string, (typeof versions)[number]>()
  for (const v of versions) {
    if (!latestByAgent.has(v.agentId)) latestByAgent.set(v.agentId, v)
  }
  return agents.map((a) => ({
    ...a,
    config: latestByAgent.get(a.id)?.config ?? null,
  }))
}

// Same version/draft lifecycle as workflows (payload is the AgentConfig). The
// entity row (name/icon/color) is created here; versions go through the factory.
const agentVersions = createVersionedEntity<
  AgentConfig,
  typeof wfAgentVersion.$inferSelect
>({
  versionTable: wfAgentVersion,
  draftTable: wfAgentDraft,
  versionOwnerCol: wfAgentVersion.agentId,
  versionNumberCol: wfAgentVersion.versionNumber,
  draftOwnerCol: wfAgentDraft.agentId,
  ownerKey: 'agentId',
  payloadKey: 'config',
})

export async function createAgent(
  db: WfDb,
  input: {
    name: string
    description?: string
    icon?: string
    color?: string
    createdBy?: string
    config: AgentConfig
  },
) {
  const agentId = crypto.randomUUID()
  await db.insert(wfAgent).values({
    id: agentId,
    name: input.name,
    description: input.description ?? null,
    icon: input.icon ?? null,
    color: input.color ?? null,
    createdBy: input.createdBy ?? null,
  })
  // Seed version 1 + a matching draft so the editor opens on a valid agent.
  const { versionId } = await agentVersions.seed(db, {
    ownerId: agentId,
    payload: input.config,
    createdBy: input.createdBy,
  })
  return { agentId, versionId }
}

export function latestAgentVersion(db: WfDb, agentId: string) {
  return agentVersions.latest(db, agentId)
}

/** A specific published version by its number (for pinned agent references). */
async function agentVersionByNumber(
  db: WfDb,
  agentId: string,
  versionNumber: number,
) {
  const rows = await db
    .select()
    .from(wfAgentVersion)
    .where(
      and(
        eq(wfAgentVersion.agentId, agentId),
        eq(wfAgentVersion.versionNumber, versionNumber),
      ),
    )
    .limit(1)
  return rows[0]
}

/** The editor's load shape: the agent, its draft (if any), latest version. */
export async function getAgent(db: WfDb, agentId: string) {
  const agent = (
    await db.select().from(wfAgent).where(eq(wfAgent.id, agentId)).limit(1)
  )[0]
  if (!agent) {
    return null
  }
  const draft = (
    await db
      .select()
      .from(wfAgentDraft)
      .where(eq(wfAgentDraft.agentId, agentId))
      .limit(1)
  )[0]
  const currentVersion = await latestAgentVersion(db, agentId)
  return {
    agent,
    draft: draft ?? null,
    currentVersion: currentVersion ?? null,
  }
}

export async function updateAgentDraft(
  db: WfDb,
  input: { agentId: string; config: AgentConfig; lastEditedBy?: string },
) {
  await agentVersions.updateDraft(db, {
    ownerId: input.agentId,
    payload: input.config,
    lastEditedBy: input.lastEditedBy,
  })
}

/** Freeze the config into a new immutable version (the editor's "publish"). */
export async function publishAgent(
  db: WfDb,
  input: {
    agentId: string
    config: AgentConfig
    changeNote?: string
    publishedBy?: string
  },
) {
  return await agentVersions.publish(db, {
    ownerId: input.agentId,
    payload: input.config,
    publishedBy: input.publishedBy,
    changeNote: input.changeNote,
  })
}

export async function listAgentVersions(db: WfDb, agentId: string) {
  return await db
    .select({
      id: wfAgentVersion.id,
      versionNumber: wfAgentVersion.versionNumber,
      changeNote: wfAgentVersion.changeNote,
      createdAt: wfAgentVersion.createdAt,
      publishedAt: wfAgentVersion.publishedAt,
    })
    .from(wfAgentVersion)
    .where(eq(wfAgentVersion.agentId, agentId))
    .orderBy(desc(wfAgentVersion.versionNumber))
}

/** Edit the agent's display metadata (name / description / icon / color). */
export async function updateAgentMeta(
  db: WfDb,
  input: {
    agentId: string
    name?: string
    description?: string
    icon?: string
    color?: string
  },
) {
  await db
    .update(wfAgent)
    .set({
      ...pickDefined(input, ['name', 'description', 'icon', 'color']),
      updatedAt: new Date(),
    })
    .where(eq(wfAgent.id, input.agentId))
}

/**
 * Soft-delete an agent. Re-checks live workflow references first (defense against
 * a race where a workflow connected the agent between the dialog opening and the
 * confirm) and refuses if any remain — the caller is expected to have already
 * surfaced the block, so this throw is a backstop, not the primary UX.
 */
export async function archiveAgent(db: WfDb, input: { agentId: string }) {
  const referencing = await listWorkflowsReferencingAgent(db, input)
  if (referencing.length > 0) {
    throw new Error(
      `Cannot archive: this agent is still used by ${referencing.length} workflow(s). Disconnect it first.`,
    )
  }
  await db
    .update(wfAgent)
    .set({ archived: true, updatedAt: new Date() })
    .where(eq(wfAgent.id, input.agentId))
}

/** Reset the draft back to the latest published version's config. */
export async function discardAgentDraft(db: WfDb, input: { agentId: string }) {
  await agentVersions.discardDraft(db, input.agentId)
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
