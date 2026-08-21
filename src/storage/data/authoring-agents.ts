import { desc, eq, inArray } from 'drizzle-orm'

import { agentConfigSchema, type AgentConfig } from '../../engine/graph'
import type { WfDb } from '../client'
import { wfAgent, wfAgentDraft, wfAgentVersion } from '../schema'
import { createVersionedEntity } from '../versioned-entity'

import { listWorkflowsReferencingAgent } from './authoring-workflows-references'
import { pickDefined, selectChunked } from './shared'

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
  // query per parameter-budget chunk of agent ids, highest version-number
  // first, first-seen-per-agent wins — chunking only breaks the ordering
  // ACROSS chunks, and every version of a given agent lands in one chunk.
  const versions = await selectChunked(
    agents.map((a) => a.id),
    (ids) =>
      db
        .select()
        .from(wfAgentVersion)
        .where(inArray(wfAgentVersion.agentId, ids))
        .orderBy(desc(wfAgentVersion.versionNumber)),
  )
  const latestByAgent = new Map<string, (typeof versions)[number]>()
  for (const v of versions) {
    if (!latestByAgent.has(v.agentId)) latestByAgent.set(v.agentId, v)
  }
  return agents.map((a) => ({
    ...a,
    config: latestByAgent.get(a.id)?.config ?? null,
    latestVersionNumber: latestByAgent.get(a.id)?.versionNumber ?? null,
  }))
}

// Same version/draft lifecycle as workflows (payload is the AgentConfig). The
// entity row (name/icon/color) is created here; versions go through the factory.
const agentVersions = createVersionedEntity<
  AgentConfig,
  typeof wfAgentVersion.$inferSelect,
  typeof wfAgent.$inferSelect,
  typeof wfAgentDraft.$inferSelect
>({
  entityTable: wfAgent,
  entityIdCol: wfAgent.id,
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
    /** Stable cross-environment identity (see `wfAgent.slug`); import sets it. */
    slug?: string
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
    slug: input.slug ?? null,
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

/**
 * A specific published agent version by NUMBER — how a pinned reference (a
 * graph node's `config.version`, or an eval Goal's `targetVersion`) resolves.
 * Undefined when that number was never published.
 */
export function agentVersionByNumber(
  db: WfDb,
  agentId: string,
  versionNumber: number,
) {
  return agentVersions.byNumber(db, agentId, versionNumber)
}

/** Cheap existence check (see `workflowExists`) — one indexed `SELECT id`. */
export function agentExists(db: WfDb, agentId: string): Promise<boolean> {
  return agentVersions.exists(db, agentId)
}

/** The editor's load shape: the agent, its draft (if any), latest version. */
export async function getAgent(db: WfDb, agentId: string) {
  const loaded = await agentVersions.load(db, agentId)
  if (!loaded) return null
  return {
    agent: loaded.entity,
    draft: loaded.draft,
    currentVersion: loaded.currentVersion,
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
    /** The AI summary, when the publish dialog already had it (else filled later). */
    aiSummaryShort?: string
    aiSummaryLong?: string
    publishedBy?: string
  },
) {
  return await agentVersions.publish(db, {
    ownerId: input.agentId,
    payload: input.config,
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
 * in the background (e.g. via `waitUntil`). Mirrors `setVersionAiSummary`.
 */
export async function setAgentVersionAiSummary(
  db: WfDb,
  input: { versionId: string; short: string; long: string },
) {
  await db
    .update(wfAgentVersion)
    .set({ aiSummaryShort: input.short, aiSummaryLong: input.long })
    .where(eq(wfAgentVersion.id, input.versionId))
}

// The single boundary where a stored agent config JSON column becomes a typed
// `AgentConfig`. Parsing here (rather than blind-casting at each read site) is
// what lets rows written before a field was added or removed still load — the
// schema's defaults and `migrateInputKind` preprocessor do the forward port.
export function parseStoredAgentConfig(value: unknown): AgentConfig {
  return agentConfigSchema.parse(value)
}

/**
 * One published version's config, for loading history back into the editor.
 * The agent twin of `getVersionGraph`.
 */
export async function getAgentVersionConfig(
  db: WfDb,
  versionId: string,
): Promise<{
  config: AgentConfig
  versionNumber: number
  agentId: string
} | null> {
  const row = (
    await db
      .select()
      .from(wfAgentVersion)
      .where(eq(wfAgentVersion.id, versionId))
      .limit(1)
  )[0]
  return row
    ? {
        config: parseStoredAgentConfig(row.config),
        versionNumber: row.versionNumber,
        agentId: row.agentId,
      }
    : null
}

export async function listAgentVersions(db: WfDb, agentId: string) {
  // Deliberately no `config` in the select — the history list renders notes and
  // summaries only, and a full config per row would make opening the dropdown
  // as expensive as loading every version of the agent.
  return await db
    .select({
      id: wfAgentVersion.id,
      versionNumber: wfAgentVersion.versionNumber,
      changeNote: wfAgentVersion.changeNote,
      aiSummaryShort: wfAgentVersion.aiSummaryShort,
      aiSummaryLong: wfAgentVersion.aiSummaryLong,
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
  await agentVersions.updateMeta(
    db,
    input.agentId,
    pickDefined(input, ['name', 'description', 'icon', 'color']),
  )
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
