import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'

import { connectorToolId } from '../../connectors/tool-id'
import type { WfDb } from '../client'
import {
  WF_CONNECTION_WORKSPACE_OWNER,
  wfConnector,
  wfConnectorClient,
  wfConnectorConnection,
  wfConnectorOauthState,
  wfConnectorTool,
  type WfConnectionOwnerScope,
  type WfConnectionStatus,
  type WfConnectorAuthKind,
  type WfConnectorTransport,
} from '../schema'

// Data access for MCP connectors: the configured servers, their cached tool
// catalogs, the credentials, the registered OAuth clients, and the in-flight
// authorization attempts.
//
// Pure DB access — no network, no crypto. Callers hand in ciphertext and get
// ciphertext back; encryption is the connector layer's job (`../../connectors`),
// which keeps the key out of the storage layer entirely and makes the "did this
// column ever hold plaintext" question answerable by reading one module.

export type ConnectorRow = typeof wfConnector.$inferSelect
export type ConnectorToolRow = typeof wfConnectorTool.$inferSelect
export type ConnectorConnectionRow = typeof wfConnectorConnection.$inferSelect

/** The owner of a connection. v1 only ever writes the workspace form. */
export type ConnectionOwner = {
  scope: WfConnectionOwnerScope
  /** Host user id for `user` scope; ignored (and stored as `''`) otherwise. */
  id?: string
}

export const WORKSPACE_OWNER: ConnectionOwner = { scope: 'workspace' }

function ownerId(owner: ConnectionOwner): string {
  return owner.scope === 'workspace'
    ? WF_CONNECTION_WORKSPACE_OWNER
    : (owner.id ?? '')
}

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

export type UpsertConnectorInput = {
  id: string
  label: string
  url: string
  transport?: WfConnectorTransport
  authKind?: WfConnectorAuthKind
  scopes?: string | null
  enabled?: boolean
  icon?: string | null
  iconName?: string | null
  color?: string | null
  note?: string | null
}

/** Every configured connector, display order. */
export async function listConnectors(db: WfDb): Promise<ConnectorRow[]> {
  return await db.select().from(wfConnector).orderBy(asc(wfConnector.label))
}

export async function getConnector(
  db: WfDb,
  id: string,
): Promise<ConnectorRow | null> {
  const [row] = await db
    .select()
    .from(wfConnector)
    .where(eq(wfConnector.id, id))
    .limit(1)
  return row ?? null
}

/**
 * Create or update a connector.
 *
 * `id` is the slug and is never rewritten by an update — it is embedded in every
 * tool id and therefore in published agent configs. Changing which server a slug
 * points at is allowed (a staging URL becoming production); renaming the slug is
 * not, and is instead a delete plus a create.
 */
export async function upsertConnector(
  db: WfDb,
  input: UpsertConnectorInput,
): Promise<void> {
  const now = new Date()
  const fields = {
    label: input.label,
    url: input.url,
    transport: input.transport ?? ('http' as const),
    authKind: input.authKind ?? ('oauth2' as const),
    scopes: input.scopes ?? null,
    enabled: input.enabled ?? true,
    icon: input.icon ?? null,
    iconName: input.iconName ?? null,
    color: input.color ?? null,
    note: input.note ?? null,
    updatedAt: now,
  }
  await db
    .insert(wfConnector)
    .values({ id: input.id, ...fields })
    .onConflictDoUpdate({ target: wfConnector.id, set: fields })
}

export async function setConnectorEnabled(
  db: WfDb,
  input: { connectorId: string; enabled: boolean },
): Promise<void> {
  await db
    .update(wfConnector)
    .set({ enabled: input.enabled, updatedAt: new Date() })
    .where(eq(wfConnector.id, input.connectorId))
}

export async function touchConnectorRefreshed(
  db: WfDb,
  connectorId: string,
  refreshedAt: Date,
): Promise<void> {
  await db
    .update(wfConnector)
    .set({ lastRefreshedAt: refreshedAt, updatedAt: refreshedAt })
    .where(eq(wfConnector.id, connectorId))
}

/**
 * Remove a connector and everything hanging off it.
 *
 * Deliberately cascades in code rather than by FK: nothing else in `wf_*` uses
 * foreign keys (rows outlive the things they describe on purpose), and a
 * disconnected connector's credential must not survive its connector.
 */
export async function deleteConnector(
  db: WfDb,
  connectorId: string,
): Promise<void> {
  // Sequential, not `db.batch`: the HTTP client replays a batch
  // non-atomically anyway (see `../client`), so the atomicity a batch appears
  // to buy is not something every caller actually gets. The credential goes
  // FIRST — if anything here fails halfway, the thing that must not survive is
  // the live token, not the catalog rows.
  await db
    .delete(wfConnectorConnection)
    .where(eq(wfConnectorConnection.connectorId, connectorId))
  await db
    .delete(wfConnectorClient)
    .where(eq(wfConnectorClient.connectorId, connectorId))
  await db
    .delete(wfConnectorOauthState)
    .where(eq(wfConnectorOauthState.connectorId, connectorId))
  await db
    .delete(wfConnectorTool)
    .where(eq(wfConnectorTool.connectorId, connectorId))
  await db.delete(wfConnector).where(eq(wfConnector.id, connectorId))
}

// ---------------------------------------------------------------------------
// Tool catalog
// ---------------------------------------------------------------------------

/** One tool as discovered from a server's `tools/list`. */
export type DiscoveredTool = {
  name: string
  title?: string | null
  description?: string | null
  inputSchema?: unknown
  outputSchema?: unknown
  annotations?: unknown
  /** Derived from `annotations.readOnlyHint` by the caller. */
  sideEffect: 'read' | 'write'
  schemaHash: string
}

/**
 * The refreshable columns, taken from the row being inserted, so the conflict
 * path costs no extra bound parameters.
 *
 * `enabled` is absent by design — that is the curation flag a human owns, and a
 * refresh that re-enabled a tool someone had switched off would quietly widen
 * what every agent can call. `side_effect` is absent for the same reason and
 * restored conditionally below. `missing_since` is cleared: a tool that came
 * back is no longer missing.
 */
const TOOL_REFRESH_SET = {
  toolName: sql`excluded.tool_name`,
  title: sql`excluded.title`,
  description: sql`excluded.description`,
  inputSchema: sql`excluded.input_schema`,
  outputSchema: sql`excluded.output_schema`,
  annotations: sql`excluded.annotations`,
  schemaHash: sql`excluded.schema_hash`,
  lastSeenAt: sql`excluded.last_seen_at`,
  missingSince: sql`null`,
  updatedAt: sql`excluded.updated_at`,
  // Respect a human's override; otherwise track what the server now says.
  sideEffect: sql`case when wf_connector_tool.side_effect_overridden then wf_connector_tool.side_effect else excluded.side_effect end`,
}

/**
 * Persist a connector's freshly-discovered catalog.
 *
 * New tools are ALWAYS inserted disabled — nothing a server advertises becomes
 * callable until a human enables it — and existing rows keep `enabled` and any
 * side-effect override while their metadata refreshes. Tools that have vanished
 * from the server are marked `missingSince` rather than deleted, because an
 * agent may still reference one and "withdrawn by the server" is a better
 * answer than an unresolvable id.
 *
 * Returns what changed, which is what the caller turns into `wf_change` rows and
 * what the UI reports after a Refresh.
 */
export async function upsertConnectorTools(
  db: WfDb,
  connectorId: string,
  tools: DiscoveredTool[],
): Promise<{
  added: string[]
  updated: string[]
  missing: string[]
  /** Ids whose schema hash moved — the drift signal. */
  drifted: string[]
}> {
  const now = new Date()
  const existing = await db
    .select()
    .from(wfConnectorTool)
    .where(eq(wfConnectorTool.connectorId, connectorId))
  const byId = new Map(existing.map((r) => [r.id, r]))

  const added: string[] = []
  const updated: string[] = []
  const drifted: string[] = []

  const rows = tools.map((t) => {
    const id = connectorToolId(connectorId, t.name)
    const prior = byId.get(id)
    if (!prior) added.push(id)
    else {
      updated.push(id)
      if (prior.schemaHash !== t.schemaHash) drifted.push(id)
    }
    return {
      id,
      connectorId,
      toolName: t.name,
      title: t.title ?? null,
      description: t.description ?? null,
      inputSchema: t.inputSchema ?? null,
      outputSchema: t.outputSchema ?? null,
      annotations: t.annotations ?? null,
      sideEffect: t.sideEffect,
      // Only meaningful on INSERT; the conflict path never touches it.
      sideEffectOverridden: false,
      enabled: false,
      schemaHash: t.schemaHash,
      lastSeenAt: now,
      missingSince: null,
      updatedAt: now,
    }
  })

  const seen = new Set(rows.map((r) => r.id))
  const missing = existing
    .filter((r) => !seen.has(r.id) && !r.missingSince)
    .map((r) => r.id)

  // D1 caps bound parameters per statement; derive the chunk size from the row
  // width so adding a column can't silently blow the budget. A catalog is tens
  // of tools, not the hundreds a model refresh carries, so these are issued
  // sequentially rather than as a batch — the round trips are few, and the HTTP
  // client replays a batch non-atomically anyway (see `../client`).
  if (rows.length > 0) {
    const perRow = Object.keys(rows[0]).length
    const perStatement = Math.max(1, Math.floor(100 / perRow))
    for (let i = 0; i < rows.length; i += perStatement) {
      await db
        .insert(wfConnectorTool)
        .values(rows.slice(i, i + perStatement))
        .onConflictDoUpdate({
          target: wfConnectorTool.id,
          set: TOOL_REFRESH_SET,
        })
    }
  }
  if (missing.length > 0) {
    await db
      .update(wfConnectorTool)
      .set({ missingSince: now, updatedAt: now })
      .where(inArray(wfConnectorTool.id, missing))
  }

  return { added, updated, missing, drifted }
}

/** A connector's tools, for the connector detail page. */
export async function listConnectorTools(
  db: WfDb,
  connectorId: string,
): Promise<ConnectorToolRow[]> {
  return await db
    .select()
    .from(wfConnectorTool)
    .where(eq(wfConnectorTool.connectorId, connectorId))
    .orderBy(asc(wfConnectorTool.toolName))
}

/**
 * Every tool that is actually callable right now: enabled, still advertised by
 * its server, and belonging to an enabled connector.
 *
 * This is the resolver's and the editor's view. The three conditions are ANDed
 * here rather than at the call sites so "callable" cannot come to mean two
 * different things in the picker and at execution time.
 */
export async function listEnabledConnectorTools(
  db: WfDb,
): Promise<{ tool: ConnectorToolRow; connector: ConnectorRow }[]> {
  const rows = await db
    .select({ tool: wfConnectorTool, connector: wfConnector })
    .from(wfConnectorTool)
    .innerJoin(wfConnector, eq(wfConnector.id, wfConnectorTool.connectorId))
    .where(
      and(
        eq(wfConnectorTool.enabled, true),
        eq(wfConnector.enabled, true),
        isNull(wfConnectorTool.missingSince),
      ),
    )
    .orderBy(asc(wfConnector.label), asc(wfConnectorTool.toolName))
  return rows
}

/** One tool by its namespaced id, with its connector. Null if either is gone. */
export async function getConnectorTool(
  db: WfDb,
  toolId: string,
): Promise<{ tool: ConnectorToolRow; connector: ConnectorRow } | null> {
  const [row] = await db
    .select({ tool: wfConnectorTool, connector: wfConnector })
    .from(wfConnectorTool)
    .innerJoin(wfConnector, eq(wfConnector.id, wfConnectorTool.connectorId))
    .where(eq(wfConnectorTool.id, toolId))
    .limit(1)
  return row ?? null
}

export async function setConnectorToolEnabled(
  db: WfDb,
  input: { toolId: string; enabled: boolean },
): Promise<void> {
  await db
    .update(wfConnectorTool)
    .set({ enabled: input.enabled, updatedAt: new Date() })
    .where(eq(wfConnectorTool.id, input.toolId))
}

/**
 * Override a tool's side-effect classification.
 *
 * Sets the sticky flag so the next refresh doesn't revert it — the server's
 * annotation is a hint, and a human who has read the tool's docs outranks it.
 */
export async function setConnectorToolSideEffect(
  db: WfDb,
  input: { toolId: string; sideEffect: 'read' | 'write' },
): Promise<void> {
  await db
    .update(wfConnectorTool)
    .set({
      sideEffect: input.sideEffect,
      sideEffectOverridden: true,
      updatedAt: new Date(),
    })
    .where(eq(wfConnectorTool.id, input.toolId))
}

// ---------------------------------------------------------------------------
// Connections (credentials)
// ---------------------------------------------------------------------------

export type SaveConnectionInput = {
  connectorId: string
  owner?: ConnectionOwner
  /** Ciphertext. See the module header. */
  accessToken: string
  refreshToken?: string | null
  tokenType?: string
  expiresAt?: Date | null
  scopes?: string | null
  accountLabel?: string | null
  connectedBy?: string | null
}

/**
 * Store a freshly-minted credential, replacing any existing one for the same
 * owner. Resets `status` and clears `lastError`: a successful connect is the
 * answer to whatever the previous failure was.
 */
export async function saveConnection(
  db: WfDb,
  input: SaveConnectionInput,
): Promise<void> {
  const now = new Date()
  const owner = input.owner ?? WORKSPACE_OWNER
  const fields = {
    accessToken: input.accessToken,
    refreshToken: input.refreshToken ?? null,
    tokenType: input.tokenType ?? 'Bearer',
    expiresAt: input.expiresAt ?? null,
    scopes: input.scopes ?? null,
    accountLabel: input.accountLabel ?? null,
    status: 'connected' as const,
    lastError: null,
    connectedBy: input.connectedBy ?? null,
    updatedAt: now,
    // A reconnect starts a new token lineage; bumping the version invalidates
    // any in-flight refresh that read the old row.
    tokenVersion: sql`${wfConnectorConnection.tokenVersion} + 1`,
  }
  await db
    .insert(wfConnectorConnection)
    .values({
      connectorId: input.connectorId,
      ownerScope: owner.scope,
      ownerId: ownerId(owner),
      ...fields,
      tokenVersion: 0,
    })
    .onConflictDoUpdate({
      target: [
        wfConnectorConnection.connectorId,
        wfConnectorConnection.ownerScope,
        wfConnectorConnection.ownerId,
      ],
      set: fields,
    })
}

export async function getConnection(
  db: WfDb,
  connectorId: string,
  owner: ConnectionOwner = WORKSPACE_OWNER,
): Promise<ConnectorConnectionRow | null> {
  const [row] = await db
    .select()
    .from(wfConnectorConnection)
    .where(
      and(
        eq(wfConnectorConnection.connectorId, connectorId),
        eq(wfConnectorConnection.ownerScope, owner.scope),
        eq(wfConnectorConnection.ownerId, ownerId(owner)),
      ),
    )
    .limit(1)
  return row ?? null
}

/** Every connection, for the list page's status column. */
export async function listConnections(
  db: WfDb,
): Promise<ConnectorConnectionRow[]> {
  return await db.select().from(wfConnectorConnection)
}

/**
 * Replace the token pair after a refresh-grant, but ONLY if nothing else has
 * written since we read.
 *
 * This is the whole reason `tokenVersion` exists. Two nodes in the same run can
 * hit an expired token simultaneously; both attempt a refresh; the loser's
 * single-use refresh token has already been consumed by the winner. Returning
 * `false` tells the loser to re-read rather than fail — the row it wanted is
 * already there.
 */
export async function updateConnectionTokens(
  db: WfDb,
  input: {
    connectionId: string
    expectedVersion: number
    accessToken: string
    refreshToken?: string | null
    expiresAt?: Date | null
    scopes?: string | null
  },
): Promise<boolean> {
  const updated = await db
    .update(wfConnectorConnection)
    .set({
      accessToken: input.accessToken,
      refreshToken: input.refreshToken ?? null,
      expiresAt: input.expiresAt ?? null,
      ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
      status: 'connected' as const,
      lastError: null,
      tokenVersion: input.expectedVersion + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(wfConnectorConnection.id, input.connectionId),
        eq(wfConnectorConnection.tokenVersion, input.expectedVersion),
      ),
    )
    // `RETURNING` rather than a driver's affected-row count: that count is
    // reported differently by D1, bun:sqlite and the HTTP proxy client, and a
    // shape mismatch would silently read as "we lost the race" on every single
    // refresh — turning the guard into a permanent outage.
    .returning({ id: wfConnectorConnection.id })
  return updated.length > 0
}

/**
 * Flag a connection as unusable.
 *
 * Called when the server answers 401 — which is how a revoked or expired grant
 * actually surfaces. Recording it turns an anonymous tool failure inside a run
 * into a "Reconnect" button on the connectors page.
 */
export async function setConnectionStatus(
  db: WfDb,
  input: {
    connectionId: string
    status: WfConnectionStatus
    error?: string | null
  },
): Promise<void> {
  await db
    .update(wfConnectorConnection)
    .set({
      status: input.status,
      lastError: input.error ?? null,
      updatedAt: new Date(),
    })
    .where(eq(wfConnectorConnection.id, input.connectionId))
}

export async function deleteConnection(
  db: WfDb,
  connectorId: string,
  owner: ConnectionOwner = WORKSPACE_OWNER,
): Promise<void> {
  await db
    .delete(wfConnectorConnection)
    .where(
      and(
        eq(wfConnectorConnection.connectorId, connectorId),
        eq(wfConnectorConnection.ownerScope, owner.scope),
        eq(wfConnectorConnection.ownerId, ownerId(owner)),
      ),
    )
}

// ---------------------------------------------------------------------------
// Registered OAuth clients
// ---------------------------------------------------------------------------

export async function getConnectorClient(
  db: WfDb,
  connectorId: string,
): Promise<typeof wfConnectorClient.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(wfConnectorClient)
    .where(eq(wfConnectorClient.connectorId, connectorId))
    .limit(1)
  return row ?? null
}

export async function saveConnectorClient(
  db: WfDb,
  input: {
    connectorId: string
    clientId: string
    /** Ciphertext, or null for a public (PKCE-only) client. */
    clientSecret?: string | null
    redirectUri: string
    issuer?: string | null
    raw?: unknown
  },
): Promise<void> {
  const now = new Date()
  const fields = {
    clientId: input.clientId,
    clientSecret: input.clientSecret ?? null,
    redirectUri: input.redirectUri,
    issuer: input.issuer ?? null,
    raw: input.raw ?? null,
    updatedAt: now,
  }
  await db
    .insert(wfConnectorClient)
    .values({ connectorId: input.connectorId, ...fields })
    .onConflictDoUpdate({ target: wfConnectorClient.connectorId, set: fields })
}

// ---------------------------------------------------------------------------
// In-flight authorization attempts
// ---------------------------------------------------------------------------

export type OauthStateInput = {
  state: string
  connectorId: string
  /** Ciphertext of the PKCE verifier. */
  codeVerifier: string
  redirectUri: string
  tokenEndpoint: string
  issuer?: string | null
  scopes?: string | null
  returnTo?: string | null
  userId?: string | null
  expiresAt: Date
}

export async function createOauthState(
  db: WfDb,
  input: OauthStateInput,
): Promise<void> {
  await db.insert(wfConnectorOauthState).values({
    state: input.state,
    connectorId: input.connectorId,
    codeVerifier: input.codeVerifier,
    redirectUri: input.redirectUri,
    tokenEndpoint: input.tokenEndpoint,
    issuer: input.issuer ?? null,
    scopes: input.scopes ?? null,
    returnTo: input.returnTo ?? null,
    userId: input.userId ?? null,
    expiresAt: input.expiresAt,
  })
}

/**
 * Read and DELETE an authorization attempt in one go.
 *
 * Single-use is the security property: a replayed callback — the user hitting
 * back, or an attacker resubmitting a captured redirect — finds nothing. The
 * delete is unconditional even when the row has expired, so a stale attempt
 * can't be retried either.
 */
export async function consumeOauthState(
  db: WfDb,
  state: string,
): Promise<typeof wfConnectorOauthState.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(wfConnectorOauthState)
    .where(eq(wfConnectorOauthState.state, state))
    .limit(1)
  if (!row) return null
  await db
    .delete(wfConnectorOauthState)
    .where(eq(wfConnectorOauthState.state, state))
  if (row.expiresAt.getTime() < Date.now()) return null
  return row
}

/** Sweep abandoned attempts (the user closed the tab). */
export async function purgeExpiredOauthStates(db: WfDb): Promise<void> {
  await db
    .delete(wfConnectorOauthState)
    .where(lt(wfConnectorOauthState.expiresAt, new Date()))
}
