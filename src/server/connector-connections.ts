import { discoverCatalog, McpUnauthorizedError } from '../connectors/client'
import { beginAuthorization } from '../connectors/oauth'
import { withConnectorAuth } from '../connectors/session'
import { assertConnectorUrl } from '../connectors/url'
import type { WfConnectionOwner } from '../engine/connection-owner'
import type { WfDb } from '../storage/client'
import {
  deleteConnection,
  getConnector,
  listConnections,
  listConnectors,
  listConnectorToolsByConnector,
  touchConnectorRefreshed,
  upsertConnector,
  upsertConnectorTools,
  type ConnectorConnectionRow,
  type ConnectorRow,
} from '../storage/data/connectors'
import type { WfConnectorAuthKind } from '../storage/schema'

import { BadRequestError, NotFoundError, toEpoch } from './handlers/shared'
import type {
  ConnectorConnectionInfo,
  ConnectorRefreshResult,
  ConnectorSummary,
} from './protocol-connectors'

// Connector credentials for one owner, as plain server functions.
//
// The data plane (`createWfSdkHandlers`) manages the WORKSPACE credential from
// the connectors page, behind the editor's own gate. A host whose tenants each
// connect their own account calls these instead, from its own routes, after
// checking the caller may act for that owner — the SDK cannot know who belongs
// to which tenant. The connector itself (server, catalog, enabled tools) stays
// shared; only the credential is per owner.

export function connectionInfo(
  row: ConnectorConnectionRow | null,
): ConnectorConnectionInfo | null {
  if (!row) return null
  return {
    status: row.status,
    accountLabel: row.accountLabel,
    scopes: row.scopes,
    expiresAt: toEpoch(row.expiresAt),
    error: row.lastError,
    connectedAt: toEpoch(row.createdAt),
    // Whether expiry is self-healing. Reported rather than the token itself:
    // it is the only thing about the credential a human needs to decide
    // whether "expired" means "wait" or "go press Reconnect".
    canRefresh: !!row.refreshToken,
  }
}

export function toConnectorSummary(
  connector: ConnectorRow,
  connection: ConnectorConnectionRow | null,
  tools: { enabled: boolean }[],
): ConnectorSummary {
  return {
    id: connector.id,
    label: connector.label,
    url: connector.url,
    transport: connector.transport,
    authKind: connector.authKind,
    scopes: connector.scopes,
    enabled: connector.enabled,
    icon: connector.icon,
    iconName: connector.iconName,
    iconUrl: connector.iconUrl,
    color: connector.color,
    note: connector.note,
    lastRefreshedAt: toEpoch(connector.lastRefreshedAt),
    connection: connectionInfo(connection),
    toolCount: tools.length,
    enabledToolCount: tools.filter((t) => t.enabled).length,
  }
}

async function requireConnector(
  db: WfDb,
  connectorId: string,
): Promise<ConnectorRow> {
  const connector = await getConnector(db, connectorId)
  if (!connector) throw new NotFoundError(`Connector '${connectorId}'`)
  return connector
}

/** Every connector, each with `owner`'s connection (or null). */
export async function listOwnerConnectors(args: {
  db: WfDb
  owner: WfConnectionOwner
}): Promise<ConnectorSummary[]> {
  const [connectors, connections, toolsByConnector] = await Promise.all([
    listConnectors(args.db),
    listConnections(args.db, args.owner),
    listConnectorToolsByConnector(args.db),
  ])
  const byConnector = new Map(connections.map((r) => [r.connectorId, r]))
  return connectors.map((connector) => {
    return toConnectorSummary(
      connector,
      byConnector.get(connector.id) ?? null,
      toolsByConnector.get(connector.id) ?? [],
    )
  })
}

/**
 * Create a connector the host knows about by id, if it does not exist yet.
 * An existing one is left exactly as it is — an admin may have tuned its
 * scopes or tools — so this is safe to call before every connect.
 */
export async function ensureConnector(args: {
  db: WfDb
  /** Permanent: it is embedded in every tool id. */
  id: string
  label: string
  url: string
  authKind?: WfConnectorAuthKind
  note?: string | null
  allowInsecureUrl?: boolean
}): Promise<void> {
  if (await getConnector(args.db, args.id)) return
  await upsertConnector(args.db, {
    id: args.id,
    label: args.label,
    url: assertConnectorUrl(args.url, { allowInsecure: args.allowInsecureUrl }),
    authKind: args.authKind ?? 'oauth2',
    scopes: null,
    enabled: true,
    icon: null,
    iconName: null,
    color: null,
    note: args.note ?? null,
  })
}

/**
 * Begin an OAuth sign-in whose credential is stored for `owner`. The host's
 * callback route (`createWfConnectorCallback`) finishes it, for `userId` only.
 */
export async function startOwnerConnectorAuth(args: {
  db: WfDb
  secret: string
  connectorId: string
  owner: WfConnectionOwner
  /** Absolute URL of the host's mounted callback route. */
  redirectUri: string
  /**
   * Who is signing in; only they can complete it. Always pass it for a
   * tenant or user owner — without it any signed-in user could finish the
   * flow (see `completeAuthorization`).
   */
  userId: string | undefined
  returnTo?: string
}): Promise<{ authorizationUrl: string }> {
  const connector = await requireConnector(args.db, args.connectorId)
  if (connector.authKind !== 'oauth2') {
    throw new BadRequestError(
      `${connector.label} is configured for ${connector.authKind} auth, not OAuth.`,
    )
  }
  return await beginAuthorization({
    db: args.db,
    connector,
    redirectUri: args.redirectUri,
    secret: args.secret,
    userId: args.userId,
    returnTo: args.returnTo,
    owner: args.owner,
  })
}

/**
 * Re-read a connector's `tools/list` with `owner`'s credential. The catalog is
 * shared, so any owner's refresh updates it for everyone; new tools arrive
 * disabled as always.
 */
export async function refreshConnectorCatalog(args: {
  db: WfDb
  secret: string
  connectorId: string
  owner: WfConnectionOwner
}): Promise<ConnectorRefreshResult & { label: string }> {
  const { db, connectorId } = args
  const connector = await requireConnector(db, connectorId)

  // A server may expose its catalog unauthenticated, so a missing credential
  // is not fatal here — try, and let the server object.
  const { tools, iconUrl } = await withConnectorAuth({
    db,
    connector,
    secret: args.secret,
    requireCredential: false,
    owner: args.owner,
    run: (auth) => {
      return discoverCatalog({
        url: connector.url,
        transport: connector.transport,
        auth,
      })
    },
  })

  const result = await upsertConnectorTools(db, connectorId, tools)
  const refreshedAt = new Date()
  await touchConnectorRefreshed(db, connectorId, refreshedAt, { iconUrl })
  return {
    label: connector.label,
    refreshedAt: refreshedAt.getTime(),
    added: result.added.length,
    updated: result.updated.length,
    missing: result.missing.length,
    drifted: result.drifted,
    toolCount: tools.length,
  }
}

/**
 * `fetch` the connector's service as `owner`, outside MCP — for a service
 * whose OAuth token also authorizes its own REST API. The token is refreshed
 * first when it has expired, and a 401 marks the connection `expired` (and
 * throws), exactly as a tool call would.
 */
export async function ownerConnectorFetch(args: {
  db: WfDb
  secret: string
  connectorId: string
  owner: WfConnectionOwner
  url: string
  init?: RequestInit
}): Promise<Response> {
  const { db, connectorId } = args
  const connector = await requireConnector(db, connectorId)
  return await withConnectorAuth({
    db,
    connector,
    secret: args.secret,
    requireCredential: true,
    owner: args.owner,
    run: async (auth) => {
      const headers = new Headers(args.init?.headers)
      if (auth.kind === 'bearer') {
        headers.set('Authorization', `Bearer ${auth.token}`)
      }
      const response = await fetch(args.url, { ...args.init, headers })
      if (response.status === 401) {
        throw new McpUnauthorizedError(
          `${connector.label} rejected the stored credential (401).`,
        )
      }
      return response
    },
  })
}

/** Forget `owner`'s credential; the connector and other owners' are kept. */
export async function disconnectOwnerConnector(args: {
  db: WfDb
  connectorId: string
  owner: WfConnectionOwner
}): Promise<void> {
  await requireConnector(args.db, args.connectorId)
  await deleteConnection(args.db, args.connectorId, args.owner)
}
