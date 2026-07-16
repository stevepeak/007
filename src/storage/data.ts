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
import {
  checkTreeSchema,
  evalFixturesSchema,
  evalInitialConditionSchema,
  type CheckResult,
  type CheckTree,
  type EvalFixtures,
  type EvalInitialCondition,
} from '../eval/checks'

import type { WfDb } from './client'
import type {
  WF_EVAL_RESULT_STATUSES,
  WF_EVAL_TARGET_KINDS,
  WF_RUN_STATUSES,
} from './schema'
import {
  wfAgent,
  wfAgentDraft,
  wfAgentVersion,
  wfEvalResult,
  wfEvalRow,
  wfEvalRun,
  wfEvalSet,
  wfRun,
  wfRunStep,
  wfWorkflow,
  wfWorkflowAssignment,
  wfWorkflowDraft,
  wfWorkflowVersion
} from './schema'

// Pure data-access functions over a `WfDb` handle. No auth and no tenancy —
// workflows and agents are one global set. These back both the Cloudflare
// backend (load graph, create/finalize run) and the UI's route handlers
// (list/get/save).

// ---------------------------------------------------------------------------
// Workflows + versions + drafts
// ---------------------------------------------------------------------------

export async function listWorkflows(db: WfDb) {
  return await db
    .select()
    .from(wfWorkflow)
    // Hidden workflows (eval wrappers) are machinery, not authored content.
    .where(eq(wfWorkflow.hidden, false))
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

export async function updateWorkflow(
  db: WfDb,
  input: { workflowId: string; name?: string; description?: string | null },
) {
  const patch: { name?: string; description?: string | null; updatedAt: Date } =
    { updatedAt: new Date() }
  if (input.name !== undefined) patch.name = input.name
  if (input.description !== undefined) patch.description = input.description
  await db
    .update(wfWorkflow)
    .set(patch)
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

// Distinct (agentId, version-pin) pairs referenced by agent nodes. Two nodes
// pinning the same agent to different versions yield two pairs, so each gets its
// own manifest entry. `version` is `null` for float-to-latest nodes.
function agentPinsInGraph(
  graph: WorkflowGraph,
): { agentId: string; version: number | null }[] {
  const seen = new Map<string, { agentId: string; version: number | null }>()
  for (const node of graph.nodes) {
    if (node.kind === 'agent' && node.config.agentId) {
      const version = node.config.version ?? null
      const key = `${node.config.agentId}@${version ?? 'latest'}`
      if (!seen.has(key)) seen.set(key, { agentId: node.config.agentId, version })
    }
  }
  return [...seen.values()]
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

/** A specific published version by its number (for pinned agent references). */
export async function agentVersionByNumber(
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
    /** Marks this as an eval-produced run so the Runs explorer excludes it. */
    isEval?: boolean
  },
): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(wfRun).values({
    id,
    workflowVersionId: input.workflowVersionId,
    triggerKind: input.triggerKind,
    subjectId: input.subjectId ?? null,
    correlationId: input.correlationId ?? null,
    isEval: input.isEval ?? false,
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
  /** Include eval-produced runs. Default false — they're hidden from the explorer. */
  includeEval?: boolean
}

const RUN_PAGE_MAX = 200

// Data-rich, filtered, paginated run listing. Joins each run to its version and
// owning workflow so callers can display + search by workflow name. Returns the
// page plus the unpaginated total so the UI can render "N of M".
export async function listRuns(db: WfDb, input: ListRunsFilter) {
  const conds: SQL[] = []
  if (!input.includeEval) {
    conds.push(eq(wfRun.isEval, false))
  }
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

// ---------------------------------------------------------------------------
// Evals — suites (sets), cases (rows), test runs, per-row results
// ---------------------------------------------------------------------------
//
// Persistence only; grading (evaluate checks → verdicts) is Phase 3 (`grade.ts`)
// and starting the real run is a host-wired hook (Phase 4). JSON columns are
// validated against `src/eval/checks.ts` on write and cast on read.

export type EvalTargetKind = (typeof WF_EVAL_TARGET_KINDS)[number]
export type EvalResultStatus = (typeof WF_EVAL_RESULT_STATUSES)[number]

export type EvalRowRecord = {
  id: string
  setId: string
  name: string
  description: string | null
  initialCondition: EvalInitialCondition
  fixtures: EvalFixtures
  checks: CheckTree
  sortOrder: number
  archived: boolean
}

function toEvalRow(r: typeof wfEvalRow.$inferSelect): EvalRowRecord {
  return {
    id: r.id,
    setId: r.setId,
    name: r.name,
    description: r.description,
    initialCondition: r.initialCondition as EvalInitialCondition,
    fixtures: r.fixtures as EvalFixtures,
    checks: r.checks as CheckTree,
    sortOrder: r.sortOrder,
    archived: r.archived,
  }
}

/** Eval sets, newest first, each with its (non-archived) row count. */
export async function listEvalSets(db: WfDb, opts?: { includeArchived?: boolean }) {
  const rows = await db
    .select({
      id: wfEvalSet.id,
      name: wfEvalSet.name,
      description: wfEvalSet.description,
      targetKind: wfEvalSet.targetKind,
      targetId: wfEvalSet.targetId,
      targetVersion: wfEvalSet.targetVersion,
      triggerKind: wfEvalSet.triggerKind,
      archived: wfEvalSet.archived,
      createdAt: wfEvalSet.createdAt,
      updatedAt: wfEvalSet.updatedAt,
      rowCount: sql<number>`(select count(*) from ${wfEvalRow} where ${wfEvalRow.setId} = ${wfEvalSet.id} and ${wfEvalRow.archived} = 0)`,
    })
    .from(wfEvalSet)
    .where(opts?.includeArchived ? undefined : eq(wfEvalSet.archived, false))
    .orderBy(desc(wfEvalSet.createdAt))
  return rows
}

/** A set with its rows (ordered), or null if missing. */
export async function getEvalSet(db: WfDb, setId: string) {
  const [set] = await db
    .select()
    .from(wfEvalSet)
    .where(eq(wfEvalSet.id, setId))
    .limit(1)
  if (!set) return null
  const rows = await db
    .select()
    .from(wfEvalRow)
    .where(and(eq(wfEvalRow.setId, setId), eq(wfEvalRow.archived, false)))
    .orderBy(asc(wfEvalRow.sortOrder))
  return { set, rows: rows.map(toEvalRow) }
}

/**
 * One row plus its parent set's target/trigger identity — everything
 * `startEvalRun`/`gradeEvalResult` need to launch and grade the row without a
 * separate set fetch. Null if the row is missing or archived.
 */
export async function getEvalRow(db: WfDb, rowId: string) {
  const [row] = await db
    .select()
    .from(wfEvalRow)
    .where(and(eq(wfEvalRow.id, rowId), eq(wfEvalRow.archived, false)))
    .limit(1)
  if (!row) return null
  const [set] = await db
    .select({
      id: wfEvalSet.id,
      targetKind: wfEvalSet.targetKind,
      targetId: wfEvalSet.targetId,
      targetVersion: wfEvalSet.targetVersion,
      triggerKind: wfEvalSet.triggerKind,
    })
    .from(wfEvalSet)
    .where(eq(wfEvalSet.id, row.setId))
    .limit(1)
  if (!set) return null
  return { row: toEvalRow(row), set }
}

export async function createEvalSet(
  db: WfDb,
  input: {
    name: string
    description?: string
    targetKind: EvalTargetKind
    targetId: string
    targetVersion?: number | null
    triggerKind: string
    createdBy?: string
  },
): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(wfEvalSet).values({
    id,
    name: input.name,
    description: input.description ?? null,
    targetKind: input.targetKind,
    targetId: input.targetId,
    targetVersion: input.targetVersion ?? null,
    triggerKind: input.triggerKind,
    createdBy: input.createdBy ?? null,
  })
  return id
}

export async function updateEvalSet(
  db: WfDb,
  input: {
    setId: string
    name?: string
    description?: string | null
    targetKind?: EvalTargetKind
    targetId?: string
    targetVersion?: number | null
    triggerKind?: string
    archived?: boolean
  },
) {
  const set: Partial<typeof wfEvalSet.$inferInsert> = { updatedAt: new Date() }
  if (input.name !== undefined) set.name = input.name
  if (input.description !== undefined) set.description = input.description
  if (input.targetKind !== undefined) set.targetKind = input.targetKind
  if (input.targetId !== undefined) set.targetId = input.targetId
  if (input.targetVersion !== undefined) set.targetVersion = input.targetVersion
  if (input.triggerKind !== undefined) set.triggerKind = input.triggerKind
  if (input.archived !== undefined) set.archived = input.archived
  await db.update(wfEvalSet).set(set).where(eq(wfEvalSet.id, input.setId))
}

/** Hard-delete a set and its rows (results/runs are kept for history). */
export async function deleteEvalSet(db: WfDb, setId: string) {
  await db.delete(wfEvalRow).where(eq(wfEvalRow.setId, setId))
  await db.delete(wfEvalSet).where(eq(wfEvalSet.id, setId))
}

/** Create (no id) or update (id given) a row. Validates the JSON payloads. */
export async function upsertEvalRow(
  db: WfDb,
  input: {
    id?: string
    setId: string
    name: string
    description?: string | null
    initialCondition?: EvalInitialCondition
    fixtures?: EvalFixtures
    checks?: CheckTree
    sortOrder?: number
  },
): Promise<string> {
  const initialCondition = evalInitialConditionSchema.parse(
    input.initialCondition ?? {},
  )
  const fixtures = evalFixturesSchema.parse(input.fixtures ?? {})
  const checks = checkTreeSchema.parse(
    input.checks ?? { op: 'and', checks: [] },
  )
  if (input.id) {
    const set: Partial<typeof wfEvalRow.$inferInsert> = {
      name: input.name,
      initialCondition,
      fixtures,
      checks,
      updatedAt: new Date(),
    }
    if (input.description !== undefined) set.description = input.description
    if (input.sortOrder !== undefined) set.sortOrder = input.sortOrder
    await db.update(wfEvalRow).set(set).where(eq(wfEvalRow.id, input.id))
    return input.id
  }
  const id = crypto.randomUUID()
  await db.insert(wfEvalRow).values({
    id,
    setId: input.setId,
    name: input.name,
    description: input.description ?? null,
    initialCondition,
    fixtures,
    checks,
    sortOrder: input.sortOrder ?? 0,
  })
  return id
}

/** Soft-delete a row (archived rows drop out of the set + its row count). */
export async function deleteEvalRow(db: WfDb, rowId: string) {
  await db
    .update(wfEvalRow)
    .set({ archived: true, updatedAt: new Date() })
    .where(eq(wfEvalRow.id, rowId))
}

export async function createEvalRun(
  db: WfDb,
  input: { setIds: string[]; total?: number; createdBy?: string },
): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(wfEvalRun).values({
    id,
    setIds: input.setIds,
    total: input.total ?? 0,
    status: 'queued',
    createdBy: input.createdBy ?? null,
  })
  return id
}

/** Patch an eval run's lifecycle + rolled-up counts/score. */
export async function updateEvalRun(
  db: WfDb,
  input: {
    evalRunId: string
    status?: (typeof WF_RUN_STATUSES)[number]
    total?: number
    passed?: number
    failed?: number
    score?: number | null
    startedAt?: Date
    finishedAt?: Date
  },
) {
  const set: Partial<typeof wfEvalRun.$inferInsert> = {}
  if (input.status !== undefined) set.status = input.status
  if (input.total !== undefined) set.total = input.total
  if (input.passed !== undefined) set.passed = input.passed
  if (input.failed !== undefined) set.failed = input.failed
  if (input.score !== undefined) set.score = input.score
  if (input.startedAt !== undefined) set.startedAt = input.startedAt
  if (input.finishedAt !== undefined) set.finishedAt = input.finishedAt
  await db.update(wfEvalRun).set(set).where(eq(wfEvalRun.id, input.evalRunId))
}

export async function listEvalRuns(db: WfDb, opts?: { limit?: number }) {
  return await db
    .select()
    .from(wfEvalRun)
    .orderBy(desc(wfEvalRun.createdAt))
    .limit(Math.min(Math.max(opts?.limit ?? 50, 1), 200))
}

/** An eval run with its per-row results, or null if missing. */
export async function getEvalRun(db: WfDb, evalRunId: string) {
  const [run] = await db
    .select()
    .from(wfEvalRun)
    .where(eq(wfEvalRun.id, evalRunId))
    .limit(1)
  if (!run) return null
  const results = await db
    .select()
    .from(wfEvalResult)
    .where(eq(wfEvalResult.evalRunId, evalRunId))
    .orderBy(asc(wfEvalResult.createdAt))
  return { run, results }
}

/** Insert a per-row result placeholder (before or after the row's run grades). */
export async function insertEvalResult(
  db: WfDb,
  input: {
    evalRunId: string
    rowId: string
    wfRunId?: string
    status: EvalResultStatus
    score?: number | null
    checkResults?: CheckResult[]
  },
): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(wfEvalResult).values({
    id,
    evalRunId: input.evalRunId,
    rowId: input.rowId,
    wfRunId: input.wfRunId ?? null,
    status: input.status,
    score: input.score ?? null,
    checkResults: input.checkResults ?? [],
  })
  return id
}

/** Write a graded verdict onto an existing result. */
export async function updateEvalResult(
  db: WfDb,
  input: {
    resultId: string
    wfRunId?: string
    status?: EvalResultStatus
    score?: number | null
    checkResults?: CheckResult[]
  },
) {
  const set: Partial<typeof wfEvalResult.$inferInsert> = {}
  if (input.wfRunId !== undefined) set.wfRunId = input.wfRunId
  if (input.status !== undefined) set.status = input.status
  if (input.score !== undefined) set.score = input.score
  if (input.checkResults !== undefined) set.checkResults = input.checkResults
  await db
    .update(wfEvalResult)
    .set(set)
    .where(eq(wfEvalResult.id, input.resultId))
}
