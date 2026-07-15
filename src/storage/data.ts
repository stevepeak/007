import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  like,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'

import {
  agentConfigSchema,
  type AgentConfig,
  type WfRunManifestEntry,
  type WorkflowGraph,
} from '../engine/graph'

import type { WfDb } from './client'
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
} from './schema'

// Pure data-access functions over a `WfDb` handle. No auth and no tenancy —
// workflows and agents are one global set. These back both the Cloudflare
// backend (load graph, create/finalize run) and the UI's route handlers
// (list/get/save).

// ---------------------------------------------------------------------------
// Workflows + versions + drafts
// ---------------------------------------------------------------------------

export async function listWorkflows(db: WfDb) {
  return await db.select().from(wfWorkflow).orderBy(desc(wfWorkflow.createdAt))
}

export async function createWorkflow(
  db: WfDb,
  input: {
    name: string
    description?: string
    createdBy?: string
    graph: WorkflowGraph
  },
) {
  const workflowId = crypto.randomUUID()
  await db.insert(wfWorkflow).values({
    id: workflowId,
    name: input.name,
    description: input.description ?? null,
    createdBy: input.createdBy ?? null,
  })
  // Seed version 1 + a matching draft so the editor opens on a valid graph.
  const versionId = crypto.randomUUID()
  await db.insert(wfWorkflowVersion).values({
    id: versionId,
    workflowId,
    versionNumber: 1,
    graph: input.graph,
    createdBy: input.createdBy ?? null,
    publishedBy: input.createdBy ?? null,
    publishedAt: new Date(),
  })
  await db.insert(wfWorkflowDraft).values({
    workflowId,
    graph: input.graph,
    baseVersionId: versionId,
    lastEditedBy: input.createdBy ?? null,
    updatedAt: new Date(),
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

async function latestVersion(db: WfDb, workflowId: string) {
  const rows = await db
    .select()
    .from(wfWorkflowVersion)
    .where(eq(wfWorkflowVersion.workflowId, workflowId))
    .orderBy(desc(wfWorkflowVersion.versionNumber))
    .limit(1)
  return rows[0]
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
  await db
    .insert(wfWorkflowDraft)
    .values({
      workflowId: input.workflowId,
      graph: input.graph,
      lastEditedBy: input.lastEditedBy ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: wfWorkflowDraft.workflowId,
      set: {
        graph: input.graph,
        lastEditedBy: input.lastEditedBy ?? null,
        updatedAt: new Date(),
      },
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
  const prev = await latestVersion(db, input.workflowId)
  const versionNumber = (prev?.versionNumber ?? 0) + 1
  const versionId = crypto.randomUUID()
  await db.insert(wfWorkflowVersion).values({
    id: versionId,
    workflowId: input.workflowId,
    versionNumber,
    graph: input.graph,
    changeNote: input.changeNote ?? null,
    aiSummaryShort: input.aiSummaryShort ?? null,
    aiSummaryLong: input.aiSummaryLong ?? null,
    createdBy: input.publishedBy ?? null,
    publishedBy: input.publishedBy ?? null,
    publishedAt: new Date(),
  })
  // Keep the draft in sync with the freshly published version.
  await db
    .update(wfWorkflowDraft)
    .set({
      graph: input.graph,
      baseVersionId: versionId,
      updatedAt: new Date(),
    })
    .where(eq(wfWorkflowDraft.workflowId, input.workflowId))
  return { versionId, versionNumber }
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

export async function renameWorkflow(
  db: WfDb,
  input: { workflowId: string; name: string },
) {
  await db
    .update(wfWorkflow)
    .set({ name: input.name, updatedAt: new Date() })
    .where(eq(wfWorkflow.id, input.workflowId))
}

/** Reset the draft back to the latest published version's graph. */
export async function discardDraft(db: WfDb, input: { workflowId: string }) {
  const version = await latestVersion(db, input.workflowId)
  if (!version) {
    return
  }
  await db
    .update(wfWorkflowDraft)
    .set({
      graph: version.graph,
      baseVersionId: version.id,
      updatedAt: new Date(),
    })
    .where(eq(wfWorkflowDraft.workflowId, input.workflowId))
}

// ---------------------------------------------------------------------------
// Run manifest resolution
// ---------------------------------------------------------------------------

// Distinct agent ids referenced by agent nodes in a graph.
function agentIdsInGraph(graph: WorkflowGraph): string[] {
  const ids = new Set<string>()
  for (const node of graph.nodes) {
    if (node.kind === 'agent' && node.config.agentId) {
      ids.add(node.config.agentId)
    }
  }
  return [...ids]
}

// Distinct workflow ids called by workflow nodes in a graph.
function workflowIdsInGraph(graph: WorkflowGraph): string[] {
  const ids = new Set<string>()
  for (const node of graph.nodes) {
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
  const seenAgents = new Set<string>()
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
    for (const agentId of agentIdsInGraph(g)) {
      if (seenAgents.has(agentId)) {
        continue
      }
      seenAgents.add(agentId)
      const version = await latestAgentVersion(db, agentId)
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
 * How many workflows reference an agent (in their draft or their latest
 * published version) — powers the agent publish-warning dialog. Workflow agent
 * nodes float to the agent's latest published version, so publishing updates
 * every referencing workflow immediately.
 */
export async function countWorkflowsReferencingAgent(
  db: WfDb,
  input: { agentId: string },
): Promise<number> {
  const workflows = await db.select({ id: wfWorkflow.id }).from(wfWorkflow)
  let count = 0
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
      count++
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// Agents + versions + drafts
// ---------------------------------------------------------------------------
//
// Same lifecycle as workflows. `config` is the versioned AgentConfig
// (model, prompt, tools, output contract); name/icon/color are display metadata
// on the entity, edited in place via `updateAgentMeta`.

export async function listAgents(db: WfDb) {
  const agents = await db
    .select()
    .from(wfAgent)
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
  const versionId = crypto.randomUUID()
  await db.insert(wfAgentVersion).values({
    id: versionId,
    agentId,
    versionNumber: 1,
    config: input.config,
    createdBy: input.createdBy ?? null,
    publishedBy: input.createdBy ?? null,
    publishedAt: new Date(),
  })
  await db.insert(wfAgentDraft).values({
    agentId,
    config: input.config,
    baseVersionId: versionId,
    lastEditedBy: input.createdBy ?? null,
    updatedAt: new Date(),
  })
  return { agentId, versionId }
}

export async function latestAgentVersion(db: WfDb, agentId: string) {
  const rows = await db
    .select()
    .from(wfAgentVersion)
    .where(eq(wfAgentVersion.agentId, agentId))
    .orderBy(desc(wfAgentVersion.versionNumber))
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
  await db
    .insert(wfAgentDraft)
    .values({
      agentId: input.agentId,
      config: input.config,
      lastEditedBy: input.lastEditedBy ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: wfAgentDraft.agentId,
      set: {
        config: input.config,
        lastEditedBy: input.lastEditedBy ?? null,
        updatedAt: new Date(),
      },
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
  const prev = await latestAgentVersion(db, input.agentId)
  const versionNumber = (prev?.versionNumber ?? 0) + 1
  const versionId = crypto.randomUUID()
  await db.insert(wfAgentVersion).values({
    id: versionId,
    agentId: input.agentId,
    versionNumber,
    config: input.config,
    changeNote: input.changeNote ?? null,
    createdBy: input.publishedBy ?? null,
    publishedBy: input.publishedBy ?? null,
    publishedAt: new Date(),
  })
  await db
    .update(wfAgentDraft)
    .set({
      config: input.config,
      baseVersionId: versionId,
      updatedAt: new Date(),
    })
    .where(eq(wfAgentDraft.agentId, input.agentId))
  return { versionId, versionNumber }
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
  const set: Record<string, unknown> = { updatedAt: new Date() }
  if (input.name !== undefined) set.name = input.name
  if (input.description !== undefined) set.description = input.description
  if (input.icon !== undefined) set.icon = input.icon
  if (input.color !== undefined) set.color = input.color
  await db.update(wfAgent).set(set).where(eq(wfAgent.id, input.agentId))
}

/** Reset the draft back to the latest published version's config. */
export async function discardAgentDraft(db: WfDb, input: { agentId: string }) {
  const version = await latestAgentVersion(db, input.agentId)
  if (!version) {
    return
  }
  await db
    .update(wfAgentDraft)
    .set({
      config: version.config,
      baseVersionId: version.id,
      updatedAt: new Date(),
    })
    .where(eq(wfAgentDraft.agentId, input.agentId))
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
  const version = await latestVersion(db, assignment.workflowId)
  if (!version) {
    return null
  }
  return { workflowId: assignment.workflowId, versionId: version.id }
}

// ---------------------------------------------------------------------------
// Runs + steps
// ---------------------------------------------------------------------------

export async function createRun(
  db: WfDb,
  input: {
    workflowVersionId: string
    triggerKind: string
    subjectId?: string
    correlationId?: string
  },
): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(wfRun).values({
    id,
    workflowVersionId: input.workflowVersionId,
    triggerKind: input.triggerKind,
    subjectId: input.subjectId ?? null,
    correlationId: input.correlationId ?? null,
    status: 'queued',
  })
  return id
}

/** Freeze the resolved reference manifest onto the run (once, at run start). */
export async function setRunManifest(
  db: WfDb,
  input: { runId: string; manifest: WfRunManifestEntry[] },
) {
  await db
    .update(wfRun)
    .set({ manifest: input.manifest })
    .where(eq(wfRun.id, input.runId))
}

export async function markRunRunning(
  db: WfDb,
  input: { runId: string; cloudflareRunId?: string },
) {
  await db
    .update(wfRun)
    .set({
      status: 'running',
      startedAt: new Date(),
      cloudflareRunId: input.cloudflareRunId ?? null,
    })
    .where(eq(wfRun.id, input.runId))
}

export async function finalizeRun(
  db: WfDb,
  input: { runId: string; output: unknown },
) {
  await db
    .update(wfRun)
    .set({
      status: 'completed',
      output: input.output ?? {},
      finishedAt: new Date(),
    })
    .where(eq(wfRun.id, input.runId))
}

export async function failRun(
  db: WfDb,
  input: { runId: string; error: string },
) {
  await db
    .update(wfRun)
    .set({ status: 'failed', error: input.error, finishedAt: new Date() })
    .where(eq(wfRun.id, input.runId))
}

export type ListRunsFilter = {
  workflowVersionId?: string
  workflowId?: string
  triggerKind?: string
  status?: string
  search?: string
  since?: Date
  until?: Date
  limit?: number
  offset?: number
}

const RUN_PAGE_MAX = 200

// Data-rich, filtered, paginated run listing. Joins each run to its version and
// owning workflow so callers can display + search by workflow name. Returns the
// page plus the unpaginated total so the UI can render "N of M".
export async function listRuns(db: WfDb, input: ListRunsFilter) {
  const conds: SQL[] = []
  if (input.workflowVersionId) {
    conds.push(eq(wfRun.workflowVersionId, input.workflowVersionId))
  }
  if (input.workflowId) {
    conds.push(eq(wfWorkflowVersion.workflowId, input.workflowId))
  }
  if (input.triggerKind) {
    conds.push(eq(wfRun.triggerKind, input.triggerKind))
  }
  if (input.status) {
    conds.push(
      eq(
        wfRun.status,
        input.status as (typeof wfRun.status.enumValues)[number],
      ),
    )
  }
  if (input.since) {
    conds.push(gte(wfRun.createdAt, input.since))
  }
  if (input.until) {
    conds.push(lte(wfRun.createdAt, input.until))
  }
  if (input.search) {
    const q = `%${input.search}%`
    const match = or(
      like(wfWorkflow.name, q),
      like(wfRun.triggerKind, q),
      like(wfRun.subjectId, q),
      like(wfRun.correlationId, q),
    )
    if (match) conds.push(match)
  }
  const where = and(...conds)
  const limit = Math.min(Math.max(input.limit ?? 50, 1), RUN_PAGE_MAX)
  const offset = Math.max(input.offset ?? 0, 0)

  const rows = await db
    .select({
      id: wfRun.id,
      status: wfRun.status,
      triggerKind: wfRun.triggerKind,
      subjectId: wfRun.subjectId,
      correlationId: wfRun.correlationId,
      createdAt: wfRun.createdAt,
      startedAt: wfRun.startedAt,
      finishedAt: wfRun.finishedAt,
      error: wfRun.error,
      workflowId: wfWorkflowVersion.workflowId,
      workflowName: wfWorkflow.name,
      versionNumber: wfWorkflowVersion.versionNumber,
    })
    .from(wfRun)
    .innerJoin(
      wfWorkflowVersion,
      eq(wfRun.workflowVersionId, wfWorkflowVersion.id),
    )
    .innerJoin(wfWorkflow, eq(wfWorkflowVersion.workflowId, wfWorkflow.id))
    .where(where)
    .orderBy(desc(wfRun.createdAt))
    .limit(limit)
    .offset(offset)

  const totalRow = await db
    .select({ count: sql<number>`count(*)` })
    .from(wfRun)
    .innerJoin(
      wfWorkflowVersion,
      eq(wfRun.workflowVersionId, wfWorkflowVersion.id),
    )
    .innerJoin(wfWorkflow, eq(wfWorkflowVersion.workflowId, wfWorkflow.id))
    .where(where)

  return {
    rows,
    total: Number(totalRow[0]?.count ?? 0),
    limit,
    offset,
  }
}

/**
 * Recent invocations of one tool across all runs. A tool call is a
 * `wf_run_step` with `nodeKind = 'tool'` whose recorded `meta.toolId` matches;
 * we join back to the run (for timestamps) and its owning workflow (for a
 * display name). Newest first. Powers the tool detail page's "recent calls"
 * list.
 */
export async function listToolInvocations(
  db: WfDb,
  input: { toolId: string; limit?: number },
) {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100)
  const rows = await db
    .select({
      runId: wfRunStep.runId,
      nodeId: wfRunStep.nodeId,
      status: wfRunStep.status,
      meta: wfRunStep.meta,
      output: wfRunStep.output,
      error: wfRunStep.error,
      startedAt: wfRunStep.startedAt,
      finishedAt: wfRunStep.finishedAt,
      workflowId: wfWorkflowVersion.workflowId,
      workflowName: wfWorkflow.name,
    })
    .from(wfRunStep)
    .innerJoin(wfRun, eq(wfRunStep.runId, wfRun.id))
    .innerJoin(
      wfWorkflowVersion,
      eq(wfRun.workflowVersionId, wfWorkflowVersion.id),
    )
    .innerJoin(wfWorkflow, eq(wfWorkflowVersion.workflowId, wfWorkflow.id))
    .where(
      and(
        eq(wfRunStep.nodeKind, 'tool'),
        eq(
          sql`json_extract(${wfRunStep.meta}, '$.toolId')`,
          input.toolId,
        ),
      ),
    )
    .orderBy(desc(wfRunStep.startedAt))
    .limit(limit)
  return rows
}

/** Distinct trigger kinds present in the runs (filter dropdown). */
export async function listRunTriggerKinds(db: WfDb) {
  const rows = await db
    .selectDistinct({ triggerKind: wfRun.triggerKind })
    .from(wfRun)
    .orderBy(asc(wfRun.triggerKind))
  return rows.map((r) => r.triggerKind)
}

/** The run-inspector load shape: run, ordered steps, the version's graph. */
export async function getRun(db: WfDb, runId: string) {
  const run = (
    await db.select().from(wfRun).where(eq(wfRun.id, runId)).limit(1)
  )[0]
  if (!run) {
    return null
  }
  const steps = await db
    .select()
    .from(wfRunStep)
    .where(eq(wfRunStep.runId, runId))
    .orderBy(asc(wfRunStep.sequence))
  const version = (
    await db
      .select()
      .from(wfWorkflowVersion)
      .where(eq(wfWorkflowVersion.id, run.workflowVersionId))
      .limit(1)
  )[0]
  const workflow = version
    ? (
        await db
          .select({ id: wfWorkflow.id, name: wfWorkflow.name })
          .from(wfWorkflow)
          .where(eq(wfWorkflow.id, version.workflowId))
          .limit(1)
      )[0]
    : undefined
  return {
    run,
    steps,
    graph: version?.graph ?? null,
    versionNumber: version?.versionNumber ?? null,
    workflowId: workflow?.id ?? null,
    workflowName: workflow?.name ?? null,
  }
}

/**
 * The workflow's latest (highest-numbered) version id — the target of a "retry
 * with the upgraded workflow" restart, which starts fresh on whatever is
 * current rather than the version the failed run froze. Null if the workflow
 * has no versions.
 */
export async function getLatestVersionId(
  db: WfDb,
  workflowId: string,
): Promise<string | null> {
  const v = await latestVersion(db, workflowId)
  return v?.id ?? null
}

/**
 * The completed steps of a prior run, in walk order — used to seed a resume.
 * The GraphWorkflow replays each into the scheduler (`report`) so those nodes
 * are treated as done and execution picks up at the first not-yet-completed
 * node (the one that failed). Excludes the trigger (seeded separately from the
 * trigger input) and any terminal Output.
 */
export async function loadResumeSteps(db: WfDb, runId: string) {
  const rows = await db
    .select({
      nodeId: wfRunStep.nodeId,
      nodeKind: wfRunStep.nodeKind,
      sequence: wfRunStep.sequence,
      input: wfRunStep.input,
      output: wfRunStep.output,
      meta: wfRunStep.meta,
      branchResult: wfRunStep.branchResult,
    })
    .from(wfRunStep)
    .where(and(eq(wfRunStep.runId, runId), eq(wfRunStep.status, 'completed')))
    .orderBy(asc(wfRunStep.sequence))
  return rows.filter((r) => r.nodeKind !== 'trigger' && r.nodeKind !== 'output')
}
