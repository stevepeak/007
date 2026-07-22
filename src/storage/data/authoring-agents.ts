import { desc, eq, inArray } from 'drizzle-orm'

import type { AgentConfig } from '../../engine/graph'
import type { WfDb } from '../client'
import { wfAgent, wfAgentDraft, wfAgentVersion } from '../schema'
import { createVersionedEntity } from '../versioned-entity'

import { listWorkflowsReferencingAgent } from './authoring-workflows'
import { pickDefined } from './shared'

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

/** Cheap existence check (see `workflowExists`) — one indexed `SELECT id`. */
export async function agentExists(db: WfDb, agentId: string): Promise<boolean> {
  const row = (
    await db
      .select({ id: wfAgent.id })
      .from(wfAgent)
      .where(eq(wfAgent.id, agentId))
      .limit(1)
  )[0]
  return row !== undefined
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
