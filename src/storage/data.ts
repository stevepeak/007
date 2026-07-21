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

import type {
  AgentUsageRef,
  ModelCapabilities,
  ModelCatalog,
  ModelCatalogEntry,
  ModelOption,
  ModelProvider,
  ModelProviderKind,
  ModelProviderStatus,
} from '../engine/config'
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
  type EvalRowSnapshot,
} from '../eval/checks'

import type { WfDb } from './client'
import {
  agentUsage,
  tokenCostUsd,
  type ModelPrice,
  type ModelPriceMap,
} from './cost'
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
  wfModel,
  wfModelProvider,
  wfRun,
  wfRunLog,
  wfRunStep,
  wfWorkflow,
  wfWorkflowAssignment,
  wfWorkflowDraft,
  wfWorkflowVersion,
} from './schema'
import { createVersionedEntity } from './versioned-entity'

// Pure data-access functions over a `WfDb` handle. No auth and no tenancy —
// workflows and agents are one global set. These back both the Cloudflare
// backend (load graph, create/finalize run) and the UI's route handlers
// (list/get/save).

/**
 * Build a Drizzle `set` patch from only the named keys whose value is not
 * `undefined` — the "partial update" idiom used by every `update*` function
 * here. `null` is a real value (it clears a column) and is kept; `undefined`
 * means "leave this column untouched". Naming the keys explicitly keeps
 * unrelated input fields (ids, discriminators) out of the patch.
 */
function pickDefined<T extends object, K extends keyof T>(
  input: T,
  keys: readonly K[],
): Pick<T, K> {
  const out: Partial<Pick<T, K>> = {}
  for (const k of keys) {
    if (input[k] !== undefined) out[k] = input[k]
  }
  return out as Pick<T, K>
}

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

function latestVersion(db: WfDb, workflowId: string) {
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
    /** Stable 32-hex trace id for the run's Sentry spans + deep-link. */
    sentryTraceId?: string
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
    sentryTraceId: input.sentryTraceId ?? null,
    status: 'queued',
  })
  return id
}

// ---------------------------------------------------------------------------
// Run logs — the structured progress feed (wf_run_log)
// ---------------------------------------------------------------------------

// A structured log entry as stored/returned. Mirrors the engine's RunLogEntry
// but with `ts` required (the engine always stamps it before persistence).
export type WfRunLogRow = {
  nodeId: string | null
  nodeKind: string | null
  sequence: number | null
  level: string
  message: string
  meta: unknown
  ts: number
}

// D1 caps bound parameters (~100) per statement; each log row binds 8, so flush
// in batches well under that. Text is left intact (a single reasoning blob is
// well under the ~100 KB statement ceiling).
const MAX_LOG_ROWS_PER_INSERT = 10

// Replace all persisted logs for one node with `entries`, atomically per node.
// Called from the (idempotent, once-per-node) record step, so a retried step
// re-runs delete-then-insert and can never duplicate a node's feed. `entries`
// already carry their node id / kind / sequence / ts (stamped by the per-node
// sink). A node with nothing to say writes nothing (and clears any prior rows).
export async function replaceNodeLogs(
  db: WfDb,
  input: { runId: string; nodeId: string; entries: WfRunLogRow[] },
): Promise<void> {
  await db
    .delete(wfRunLog)
    .where(
      and(eq(wfRunLog.runId, input.runId), eq(wfRunLog.nodeId, input.nodeId)),
    )
  if (input.entries.length === 0) return
  const rows = input.entries.map((e) => ({
    id: crypto.randomUUID(),
    runId: input.runId,
    nodeId: e.nodeId ?? input.nodeId,
    nodeKind: e.nodeKind ?? null,
    sequence: e.sequence ?? null,
    level: e.level,
    message: e.message,
    meta: e.meta ?? null,
    ts: e.ts,
  }))
  for (let i = 0; i < rows.length; i += MAX_LOG_ROWS_PER_INSERT) {
    await db.insert(wfRunLog).values(rows.slice(i, i + MAX_LOG_ROWS_PER_INSERT))
  }
}

// The whole run's log feed in emit order, for the run viewer (loaded once, then
// polled while the run is live).
export async function getRunLogs(
  db: WfDb,
  runId: string,
): Promise<WfRunLogRow[]> {
  const rows = await db
    .select({
      nodeId: wfRunLog.nodeId,
      nodeKind: wfRunLog.nodeKind,
      sequence: wfRunLog.sequence,
      level: wfRunLog.level,
      message: wfRunLog.message,
      meta: wfRunLog.meta,
      ts: wfRunLog.ts,
    })
    .from(wfRunLog)
    .where(eq(wfRunLog.runId, runId))
    .orderBy(asc(wfRunLog.ts))
  return rows
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
/**
 * Every catalogued model's price, keyed for cost derivation. A run step records
 * `meta.model` as the provider-native id (`wf_model.modelId`); we key by that AND
 * the composite `id` so either resolves. One small table scan, shared by the runs
 * list (aggregate) and the run inspector (per node).
 */
export async function loadModelPriceMap(db: WfDb): Promise<ModelPriceMap> {
  const rows = await db
    .select({
      id: wfModel.id,
      modelId: wfModel.modelId,
      costPerMTok: wfModel.costPerMTok,
      promptPricePerMTok: wfModel.promptPricePerMTok,
      completionPricePerMTok: wfModel.completionPricePerMTok,
    })
    .from(wfModel)
  const map: ModelPriceMap = new Map()
  for (const r of rows) {
    const price: ModelPrice = {
      promptPerMTok: r.promptPricePerMTok,
      completionPerMTok: r.completionPricePerMTok,
      blendedPerMTok: r.costPerMTok,
    }
    map.set(r.modelId, price)
    // Don't let a composite-id entry clobber a bare-id match (what steps record).
    if (!map.has(r.id)) map.set(r.id, price)
  }
  return map
}

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

  // Aggregate token + dollar cost per run across this page's agent steps. Only
  // this page's runs are queried, so the explorer stays a single-page load.
  const rowsWithCost = await attachRunCost(db, rows)

  return {
    rows: rowsWithCost,
    total: Number(totalRow[0]?.count ?? 0),
    limit,
    offset,
  }
}

/**
 * Fold each run's agent-step token usage into a `{ totalTokens, costUsd }` pair.
 * `totalTokens` is null when a run fired no agents; `costUsd` is null when none
 * of its agents' models were priced (partial pricing yields a best-effort sum).
 */
async function attachRunCost<R extends { id: string }>(
  db: WfDb,
  rows: R[],
): Promise<Array<R & { totalTokens: number | null; costUsd: number | null }>> {
  if (rows.length === 0) return []
  const runIds = rows.map((r) => r.id)
  const [priceMap, stepRows] = await Promise.all([
    loadModelPriceMap(db),
    db
      .select({ runId: wfRunStep.runId, meta: wfRunStep.meta })
      .from(wfRunStep)
      .where(inArray(wfRunStep.runId, runIds)),
  ])

  const agg = new Map<
    string,
    { tokens: number; hasTokens: boolean; cost: number; hasCost: boolean }
  >()
  for (const sr of stepRows) {
    const usage = agentUsage(sr.meta)
    if (!usage) continue
    const a = agg.get(sr.runId) ?? {
      tokens: 0,
      hasTokens: false,
      cost: 0,
      hasCost: false,
    }
    a.tokens += usage.inputTokens + usage.outputTokens
    a.hasTokens = true
    const c = tokenCostUsd(
      usage.inputTokens,
      usage.outputTokens,
      priceMap.get(usage.model),
    )
    if (c != null) {
      a.cost += c
      a.hasCost = true
    }
    agg.set(sr.runId, a)
  }

  return rows.map((r) => {
    const a = agg.get(r.id)
    return {
      ...r,
      totalTokens: a?.hasTokens ? a.tokens : null,
      costUsd: a?.hasCost ? a.cost : null,
    }
  })
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
        eq(sql`json_extract(${wfRunStep.meta}, '$.toolId')`, input.toolId),
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
  const rawSteps = await db
    .select()
    .from(wfRunStep)
    .where(eq(wfRunStep.runId, runId))
    .orderBy(asc(wfRunStep.sequence))
  // Derive each step's dollar cost from its token usage × the model's catalog
  // price, and roll the run's totals up for the header.
  const priceMap = await loadModelPriceMap(db)
  let costUsd: number | null = null
  let totalTokens: number | null = null
  const steps = rawSteps.map((s) => {
    const usage = agentUsage(s.meta)
    const stepCost = usage
      ? tokenCostUsd(
          usage.inputTokens,
          usage.outputTokens,
          priceMap.get(usage.model),
        )
      : null
    if (usage) {
      totalTokens = (totalTokens ?? 0) + usage.inputTokens + usage.outputTokens
    }
    if (stepCost != null) costUsd = (costUsd ?? 0) + stepCost
    // `-1` is the top-level sentinel (see wfRunStep) — surface it as null so the
    // client's `itemIndex: number | null` reads naturally.
    return { ...s, itemIndex: s.itemIndex === -1 ? null : s.itemIndex, costUsd: stepCost }
  })
  const logs = await getRunLogs(db, runId)
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
    logs,
    graph: version?.graph ?? null,
    versionNumber: version?.versionNumber ?? null,
    workflowId: workflow?.id ?? null,
    workflowName: workflow?.name ?? null,
    costUsd,
    totalTokens,
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
    .where(
      and(
        eq(wfRunStep.runId, runId),
        eq(wfRunStep.status, 'completed'),
        // Top-level steps only (sentinel -1): resume seeds the top-level
        // scheduler, never an iteration's inner subgraph nodes.
        eq(wfRunStep.itemIndex, -1),
      ),
    )
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
export async function listEvalSets(
  db: WfDb,
  opts?: { includeArchived?: boolean },
) {
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
      name: wfEvalSet.name,
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
  await db
    .update(wfEvalSet)
    .set({
      ...pickDefined(input, [
        'name',
        'description',
        'targetKind',
        'targetId',
        'targetVersion',
        'triggerKind',
        'archived',
      ]),
      updatedAt: new Date(),
    })
    .where(eq(wfEvalSet.id, input.setId))
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
    await db
      .update(wfEvalRow)
      .set({
        name: input.name,
        initialCondition,
        fixtures,
        checks,
        updatedAt: new Date(),
        ...pickDefined(input, ['description', 'sortOrder']),
      })
      .where(eq(wfEvalRow.id, input.id))
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
  await db
    .update(wfEvalRun)
    .set(
      pickDefined(input, [
        'status',
        'total',
        'passed',
        'failed',
        'score',
        'startedAt',
        'finishedAt',
      ]),
    )
    .where(eq(wfEvalRun.id, input.evalRunId))
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

/**
 * Assemble the frozen {@link EvalRowSnapshot} for a result from the row + its
 * parent set (as returned by {@link getEvalRow}). Pure — the caller hashes and
 * persists it. See EvalRowSnapshot for why this replaces per-entity versioning.
 */
export function buildEvalSnapshot(
  row: EvalRowRecord,
  set: {
    id: string
    name: string
    targetKind: string
    targetId: string
    targetVersion: number | null
    triggerKind: string
  },
): EvalRowSnapshot {
  return {
    row: {
      name: row.name,
      description: row.description,
      initialCondition: row.initialCondition,
      fixtures: row.fixtures,
      checks: row.checks,
    },
    target: {
      setId: set.id,
      setName: set.name,
      targetKind: set.targetKind,
      targetId: set.targetId,
      targetVersion: set.targetVersion,
      triggerKind: set.triggerKind,
    },
  }
}

// Deterministic JSON with recursively sorted object keys, so the same logical
// snapshot always produces the same hash regardless of property insertion order.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (k) =>
        `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
    )
  return `{${entries.join(',')}}`
}

/**
 * sha256 (hex) over a snapshot's reproducibility-relevant fields: the Sample
 * inputs (initialCondition + fixtures), the checks, and the Goal target
 * identity. Excludes cosmetic name/description so a rename isn't a "change".
 * Lets callers detect whether a Sample's effective definition changed between
 * two runs, and dedup identical snapshots — the job a version counter used to do.
 */
export async function hashEvalSnapshot(
  snapshot: EvalRowSnapshot,
): Promise<string> {
  const semantic = {
    initialCondition: snapshot.row.initialCondition,
    fixtures: snapshot.row.fixtures,
    checks: snapshot.row.checks,
    targetKind: snapshot.target.targetKind,
    targetId: snapshot.target.targetId,
    targetVersion: snapshot.target.targetVersion,
    triggerKind: snapshot.target.triggerKind,
  }
  const bytes = new TextEncoder().encode(stableStringify(semantic))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
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
    /** Frozen state this result ran against — see buildEvalSnapshot. */
    snapshot?: EvalRowSnapshot | null
    /** sha256 of `snapshot` — see hashEvalSnapshot. */
    snapshotHash?: string | null
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
    snapshot: input.snapshot ?? null,
    snapshotHash: input.snapshotHash ?? null,
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
  await db
    .update(wfEvalResult)
    .set(pickDefined(input, ['wfRunId', 'status', 'score', 'checkResults']))
    .where(eq(wfEvalResult.id, input.resultId))
}

// ---------------------------------------------------------------------------
// Model catalog + providers
// ---------------------------------------------------------------------------
//
// The platform's model catalog is a single GLOBAL set (no tenancy, like the
// rest of `wf_*`). A model's `id` is the composite `providerId:modelId`; the
// pickers see only ENABLED models via `listEnabledModels`, while the admin page
// reads the whole catalog via `getModelCatalog`. `upsertModels` is the refresh
// write — it preserves the `enabled` flag so a refresh never re-hides models the
// user turned on, and never auto-enables the 300+ new ones.

type WfModelRow = typeof wfModel.$inferSelect

/** Assemble the capabilities object from a row, omitted when nothing is set. */
function rowCapabilities(r: WfModelRow): ModelCapabilities | undefined {
  if (
    !r.supportsTools &&
    !r.supportsReasoning &&
    !r.supportsStructuredOutput &&
    !r.supportsVision
  ) {
    return undefined
  }
  return {
    tools: r.supportsTools,
    reasoning: r.supportsReasoning,
    structuredOutput: r.supportsStructuredOutput,
    vision: r.supportsVision,
  }
}

/** Map a stored row to the picker-facing {@link ModelOption} (enabled subset). */
function rowToModelOption(r: WfModelRow): ModelOption {
  return {
    id: r.id,
    label: r.label,
    providerId: r.providerId,
    costPerMTok: r.costPerMTok ?? undefined,
    tokensPerSec: r.tokensPerSec ?? undefined,
    capabilities: rowCapabilities(r),
  }
}

/** Map a stored row to the admin-page {@link ModelCatalogEntry} (full metadata). */
function rowToCatalogEntry(r: WfModelRow): ModelCatalogEntry {
  return {
    id: r.id,
    modelId: r.modelId,
    label: r.label,
    providerId: r.providerId,
    vendor: r.vendor ?? undefined,
    enabled: r.enabled,
    costPerMTok: r.costPerMTok ?? undefined,
    promptPricePerMTok: r.promptPricePerMTok ?? undefined,
    completionPricePerMTok: r.completionPricePerMTok ?? undefined,
    contextLength: r.contextLength ?? undefined,
    tokensPerSec: r.tokensPerSec ?? undefined,
    releasedAt: r.releasedAt ? r.releasedAt.getTime() : undefined,
    capabilities: rowCapabilities(r),
    raw: r.raw ?? undefined,
  }
}

/**
 * The enabled models, as the pickers consume them. Empty until the platform
 * enables some (the caller falls back to the host's static list when empty).
 */
export async function listEnabledModels(db: WfDb): Promise<ModelOption[]> {
  const rows = await db
    .select()
    .from(wfModel)
    .where(eq(wfModel.enabled, true))
    .orderBy(asc(wfModel.vendor), asc(wfModel.label))
  return rows.map(rowToModelOption)
}

/** The wired-up providers, as the pickers' grouping consumes them. */
export async function listModelProviders(db: WfDb): Promise<ModelProvider[]> {
  const rows = await db
    .select()
    .from(wfModelProvider)
    .orderBy(asc(wfModelProvider.label))
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    kind: r.kind as ModelProviderKind,
    note: r.note ?? undefined,
  }))
}

/**
 * The provider status + full catalog (enabled and disabled) for the Models admin
 * page. `usage` (which agents reference each model) is assembled separately by
 * {@link getModelUsage} and merged by the handler, so this stays a pure DB read.
 */
export async function getModelCatalog(
  db: WfDb,
): Promise<Pick<ModelCatalog, 'providers' | 'models'>> {
  const [providerRows, modelRows] = await Promise.all([
    db.select().from(wfModelProvider).orderBy(asc(wfModelProvider.label)),
    db.select().from(wfModel).orderBy(asc(wfModel.vendor), asc(wfModel.label)),
  ])
  const models = modelRows.map(rowToCatalogEntry)
  const providers: ModelProviderStatus[] = providerRows.map((p) => {
    const of = models.filter((m) => m.providerId === p.id)
    return {
      id: p.id,
      label: p.label,
      kind: p.kind as ModelProviderKind,
      note: p.note ?? undefined,
      enabled: p.enabled,
      lastRefreshedAt: p.lastRefreshedAt ? p.lastRefreshedAt.getTime() : null,
      modelCount: of.length,
      enabledCount: of.filter((m) => m.enabled).length,
    }
  })
  return { providers, models }
}

/**
 * Which agents currently reference each model, keyed by CATALOG model id. An
 * agent counts if either its latest published version OR its live draft names
 * the model. Agent `modelId`s may be composite (`provider:model`) or bare
 * (legacy) — both are resolved to the catalog id by matching `wf_model.id` or
 * `wf_model.model_id`, so no provider prefix is hardcoded here.
 */
export async function getModelUsage(
  db: WfDb,
): Promise<Record<string, AgentUsageRef[]>> {
  const agents = await db.select().from(wfAgent)
  if (agents.length === 0) return {}

  // Map every known id form → canonical catalog id.
  const modelRows = await db
    .select({ id: wfModel.id, modelId: wfModel.modelId })
    .from(wfModel)
  const canonical = new Map<string, string>()
  for (const r of modelRows) {
    canonical.set(r.id, r.id)
    if (!canonical.has(r.modelId)) canonical.set(r.modelId, r.id)
  }

  const agentIds = agents.map((a) => a.id)
  const versions = await db
    .select()
    .from(wfAgentVersion)
    .where(inArray(wfAgentVersion.agentId, agentIds))
    .orderBy(desc(wfAgentVersion.versionNumber))
  const latestConfig = new Map<string, unknown>()
  for (const v of versions) {
    if (!latestConfig.has(v.agentId)) latestConfig.set(v.agentId, v.config)
  }
  const drafts = await db
    .select()
    .from(wfAgentDraft)
    .where(inArray(wfAgentDraft.agentId, agentIds))
  const draftConfig = new Map(drafts.map((d) => [d.agentId, d.config]))

  const modelIdOf = (config: unknown): string | undefined => {
    const mid = (config as { modelId?: unknown } | null | undefined)?.modelId
    return typeof mid === 'string' && mid ? mid : undefined
  }

  const usage: Record<string, AgentUsageRef[]> = {}
  const seen = new Set<string>() // `${catalogId}|${agentId}`
  for (const a of agents) {
    const ref: AgentUsageRef = {
      id: a.id,
      name: a.name,
      icon: a.icon,
      color: a.color,
    }
    const ids = new Set<string>()
    for (const cfg of [latestConfig.get(a.id), draftConfig.get(a.id)]) {
      const mid = modelIdOf(cfg)
      if (mid) ids.add(mid)
    }
    for (const mid of ids) {
      const catId = canonical.get(mid)
      if (!catId) continue
      const key = `${catId}|${a.id}`
      if (seen.has(key)) continue
      seen.add(key)
      ;(usage[catId] ??= []).push(ref)
    }
  }
  return usage
}

/**
 * Persist a provider's freshly-fetched catalog. New models are inserted DISABLED
 * (the user opts them in) and existing rows keep their `enabled` flag while their
 * metadata refreshes. `defaultEnabledIds` are enabled only on FIRST insert (the
 * host's static model ids), so there is always a working selection after the very
 * first refresh — without re-enabling a model the user later turned off. Returns
 * the number of catalog entries written.
 */
export async function upsertModels(
  db: WfDb,
  providerId: string,
  entries: Omit<ModelCatalogEntry, 'enabled'>[],
  defaultEnabledIds: readonly string[] = [],
): Promise<number> {
  if (entries.length === 0) return 0
  const now = new Date()
  const enableByDefault = new Set(defaultEnabledIds)
  for (const e of entries) {
    const caps: ModelCapabilities = e.capabilities ?? {}
    // `enabled` is intentionally absent from `meta`, so the conflict path never
    // touches it — a refresh preserves the user's curation.
    const meta = {
      providerId,
      modelId: e.modelId,
      label: e.label,
      vendor: e.vendor ?? null,
      costPerMTok: e.costPerMTok ?? null,
      promptPricePerMTok: e.promptPricePerMTok ?? null,
      completionPricePerMTok: e.completionPricePerMTok ?? null,
      contextLength: e.contextLength ?? null,
      tokensPerSec: e.tokensPerSec ?? null,
      releasedAt: e.releasedAt != null ? new Date(e.releasedAt) : null,
      supportsTools: caps.tools ?? false,
      supportsReasoning: caps.reasoning ?? false,
      supportsStructuredOutput: caps.structuredOutput ?? false,
      supportsVision: caps.vision ?? false,
      raw: e.raw ?? null,
      updatedAt: now,
    }
    await db
      .insert(wfModel)
      .values({ id: e.id, enabled: enableByDefault.has(e.id), ...meta })
      .onConflictDoUpdate({ target: wfModel.id, set: meta })
  }
  return entries.length
}

/** Toggle a single model's availability to the pickers. */
export async function setModelEnabled(
  db: WfDb,
  input: { modelId: string; enabled: boolean },
): Promise<void> {
  await db
    .update(wfModel)
    .set({ enabled: input.enabled, updatedAt: new Date() })
    .where(eq(wfModel.id, input.modelId))
}

/** Upsert a provider row and stamp its last successful refresh. */
export async function touchModelProvider(
  db: WfDb,
  provider: ModelProvider,
  refreshedAt: Date,
): Promise<void> {
  const base = {
    label: provider.label,
    kind: provider.kind,
    note: provider.note ?? null,
    lastRefreshedAt: refreshedAt,
    updatedAt: refreshedAt,
  }
  await db
    .insert(wfModelProvider)
    .values({ id: provider.id, ...base })
    .onConflictDoUpdate({ target: wfModelProvider.id, set: base })
}
