import { and, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'

import { toAgentKind, type WfAgentKind } from '../../engine/agent-kind'
import {
  decisionAgentConfigSchema,
  type AnyAgentConfig,
} from '../../engine/decision-agent-schema'
import { agentConfigSchema, type AgentConfig } from '../../engine/graph'
import type { WfDb } from '../client'
import { wfAgent, wfAgentDraft, wfAgentVersion } from '../schema'
import { createVersionedEntity } from '../versioned-entity'

import { listWorkflowsReferencingAgent } from './authoring-workflows-references'
import { inJsonArray, pickDefined, selectChunked } from './shared'

export type { AnyAgentConfig }

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
    (ids) => {
      return db
        .select()
        .from(wfAgentVersion)
        .where(inArray(wfAgentVersion.agentId, ids))
        .orderBy(desc(wfAgentVersion.versionNumber))
    },
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

/**
 * Every agent id with the little the graph linter needs: its name, whether it is
 * archived, and every published version number.
 *
 * Deliberately not `listAgents`: that one filters archived agents out (they
 * leave the node picker) and keeps only each agent's LATEST version, while the
 * linter has to judge a node pointing at an archived agent — which still runs —
 * and a node pinned to any published version. It also drags each agent's whole
 * config along, which this does not need.
 *
 * Two queries regardless of how many agents there are: the ids, then their
 * version numbers chunked by parameter budget.
 */
export async function listAgentRefs(db: WfDb): Promise<
  Map<
    string,
    {
      name: string
      archived: boolean
      latestVersionNumber: number | null
      versionNumbers: Set<number>
    }
  >
> {
  const agents = await db
    .select({
      id: wfAgent.id,
      name: wfAgent.name,
      archived: wfAgent.archived,
    })
    .from(wfAgent)
  const index = new Map<
    string,
    {
      name: string
      archived: boolean
      latestVersionNumber: number | null
      versionNumbers: Set<number>
    }
  >()
  if (agents.length === 0) return index
  for (const a of agents) {
    index.set(a.id, {
      name: a.name,
      archived: a.archived,
      latestVersionNumber: null,
      versionNumbers: new Set(),
    })
  }
  const versions = await selectChunked(
    agents.map((a) => a.id),
    (ids) => {
      return db
        .select({
          agentId: wfAgentVersion.agentId,
          versionNumber: wfAgentVersion.versionNumber,
        })
        .from(wfAgentVersion)
        .where(inArray(wfAgentVersion.agentId, ids))
    },
  )
  for (const v of versions) {
    const entry = index.get(v.agentId)
    if (!entry) continue
    entry.versionNumbers.add(v.versionNumber)
    if (
      entry.latestVersionNumber == null ||
      v.versionNumber > entry.latestVersionNumber
    ) {
      entry.latestVersionNumber = v.versionNumber
    }
  }
  return index
}

// Same version/draft lifecycle as workflows (payload is the agent's config,
// whichever shape its kind declares). The entity row (name/icon/color/kind) is
// created here; versions go through the factory.
const agentVersions = createVersionedEntity<
  AnyAgentConfig,
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
    /** Immutable once written — see `wfAgent.kind`. Omitted → 'generation'. */
    kind?: WfAgentKind
    config: AnyAgentConfig
  },
) {
  const agentId = crypto.randomUUID()
  await db.insert(wfAgent).values({
    id: agentId,
    slug: input.slug ?? null,
    name: input.name,
    kind: input.kind ?? 'generation',
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

/**
 * An agent pin resolved to its published version: `null` floats to latest, a
 * number names that exact version. Undefined when nothing matches — a pinned
 * number never falls back to latest.
 */
export function resolveAgentVersion(
  db: WfDb,
  args: { agentId: string; pin: number | null },
) {
  return args.pin == null
    ? latestAgentVersion(db, args.agentId)
    : agentVersionByNumber(db, args.agentId, args.pin)
}

/** The key {@link resolveAgentVersions} files a pin's version under. */
export function agentPinKey(args: { agentId: string; pin: number | null }) {
  return `${args.agentId}@${args.pin ?? 'latest'}`
}

/**
 * {@link resolveAgentVersion} for many pins in ONE query, keyed by
 * {@link agentPinKey}; a pin that resolves to nothing is absent. Floating pins
 * match the correlated max (see `latestVersionGraphs`); pinned ones match an
 * id × number cross product and are filtered back to their exact pairs here.
 * Both id lists travel as one JSON parameter each, so there is no chunking.
 */
export async function resolveAgentVersions(
  db: WfDb,
  pins: readonly { agentId: string; pin: number | null }[],
): Promise<Map<string, typeof wfAgentVersion.$inferSelect>> {
  const floating = [
    ...new Set(pins.filter((p) => p.pin == null).map((p) => p.agentId)),
  ]
  const pinned = pins.filter((p) => p.pin != null)
  const clauses: SQL[] = []
  if (floating.length > 0) {
    const inner = alias(wfAgentVersion, 'av_latest')
    const latestVersionNumber = db
      .select({ v: sql<number>`max(${inner.versionNumber})` })
      .from(inner)
      .where(eq(inner.agentId, wfAgentVersion.agentId))
    clauses.push(
      and(
        inJsonArray(wfAgentVersion.agentId, floating),
        eq(wfAgentVersion.versionNumber, latestVersionNumber),
      )!,
    )
  }
  if (pinned.length > 0) {
    clauses.push(
      and(
        inJsonArray(wfAgentVersion.agentId, [
          ...new Set(pinned.map((p) => p.agentId)),
        ]),
        inJsonArray(wfAgentVersion.versionNumber, [
          ...new Set(pinned.map((p) => p.pin!)),
        ]),
      )!,
    )
  }
  const out = new Map<string, typeof wfAgentVersion.$inferSelect>()
  if (clauses.length === 0) return out
  const rows = await db
    .select()
    .from(wfAgentVersion)
    .where(or(...clauses))
  const floatingIds = new Set(floating)
  const pinnedKeys = new Set(pinned.map(agentPinKey))
  // One row can answer both a pinned key and a floating one. A floating
  // agent's true latest is always among the rows, so its max row here is it,
  // even when the pinned cross product dragged in an older version too.
  const latestByAgent = new Map<string, number>()
  for (const r of rows) {
    if (!floatingIds.has(r.agentId)) continue
    const best = latestByAgent.get(r.agentId)
    if (best === undefined || r.versionNumber > best) {
      latestByAgent.set(r.agentId, r.versionNumber)
    }
  }
  for (const r of rows) {
    const pinKey = agentPinKey({ agentId: r.agentId, pin: r.versionNumber })
    if (pinnedKeys.has(pinKey)) out.set(pinKey, r)
    if (latestByAgent.get(r.agentId) === r.versionNumber) {
      out.set(agentPinKey({ agentId: r.agentId, pin: null }), r)
    }
  }
  return out
}

/** Cheap existence check (see `workflowExists`) — one indexed `SELECT id`. */
export function agentExists(db: WfDb, agentId: string): Promise<boolean> {
  return agentVersions.exists(db, agentId)
}

/**
 * The id of the live (not archived) agent with this slug, or null. The slug is
 * how host code names an agent — ids are random per database, slugs are the
 * cross-environment identity `wf-spec` syncs on (see `wfAgent.slug`).
 */
export async function agentIdBySlug(
  db: WfDb,
  slug: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: wfAgent.id })
    .from(wfAgent)
    .where(and(eq(wfAgent.slug, slug), eq(wfAgent.archived, false)))
    .limit(1)
  return row?.id ?? null
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
  input: { agentId: string; config: AnyAgentConfig; lastEditedBy?: string },
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
    config: AnyAgentConfig
    changeNote?: string
    /** The AI summary, when the publish dialog already had it (else filled later). */
    aiSummaryShort?: string
    aiSummaryLong?: string
    publishedBy?: string
    /** The live version the caller based this on; see `StaleBaseError`. */
    expectedVersionNumber?: number
  },
) {
  return await agentVersions.publish(db, {
    expectedVersionNumber: input.expectedVersionNumber,
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
 * The same boundary, for a row whose KIND is only known at run time — which is
 * every read that starts from `wf_agent` rather than from an already-narrowed
 * caller. The two schemas are disjoint, so parsing a decision config as an
 * `AgentConfig` doesn't degrade, it throws; the kind is what picks.
 */
export function parseStoredConfigOfKind(
  kind: WfAgentKind,
  value: unknown,
): AnyAgentConfig {
  return kind === 'decision'
    ? decisionAgentConfigSchema.parse(value)
    : agentConfigSchema.parse(value)
}

/**
 * One published version's config, for loading history back into the editor.
 * The agent twin of `getVersionGraph`.
 */
export async function getAgentVersionConfig(
  db: WfDb,
  versionId: string,
): Promise<{
  config: AnyAgentConfig
  kind: WfAgentKind
  versionNumber: number
  agentId: string
} | null> {
  const row = (
    await db
      .select({
        version: wfAgentVersion,
        kind: wfAgent.kind,
      })
      .from(wfAgentVersion)
      .leftJoin(wfAgent, eq(wfAgent.id, wfAgentVersion.agentId))
      .where(eq(wfAgentVersion.id, versionId))
      .limit(1)
  )[0]
  if (!row) return null
  // The join is LEFT because a version outlives nothing — but a row whose
  // agent has been hard-deleted would otherwise drop out of history entirely,
  // and reading it as a generation config is what every such row is.
  const kind = toAgentKind(row.kind)
  return {
    config: parseStoredConfigOfKind(kind, row.version.config),
    kind,
    versionNumber: row.version.versionNumber,
    agentId: row.version.agentId,
  }
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
