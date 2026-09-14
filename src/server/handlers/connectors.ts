import { discoverTools } from '../../connectors/client'
import { beginAuthorization, saveBearerToken } from '../../connectors/oauth'
import { resolveAccessToken } from '../../connectors/oauth'
import { CONNECTOR_ID_PATTERN } from '../../connectors/tool-id'
import { assertConnectorUrl } from '../../connectors/url'
import type { JsonSchema } from '../../engine/agent-output'
import {
  deleteConnection,
  deleteConnector,
  getConnection,
  getConnector,
  listConnectors,
  listConnections,
  listConnectorTools,
  setConnectorEnabled,
  setConnectorToolEnabled,
  setConnectorToolSideEffect,
  touchConnectorRefreshed,
  upsertConnector,
  upsertConnectorTools,
  type ConnectorConnectionRow,
  type ConnectorRow,
  type ConnectorToolRow,
} from '../../storage/data/connectors'
import type {
  ConnectorConnectionInfo,
  ConnectorDetail,
  ConnectorSummary,
  ConnectorToolInfo,
} from '../protocol-connectors'

import {
  BadRequestError,
  NotFoundError,
  toEpoch,
  type CreateWfSdkHandlersOptions,
  type HandlerCtx,
  type WfHandlers,
} from './shared'

// Server handlers for MCP connectors.
//
// The one rule that shapes this file: a credential never crosses the wire, in
// any form. `ConnectorConnectionInfo` describes a connection — its status, who
// it belongs to, whether it can refresh — and says nothing about the token. A
// redacted secret in a JSON payload is still a secret one screenshot away from
// being a real one.

/** Default mount for the OAuth callback the host is expected to route. */
const DEFAULT_CALLBACK_PATH = '/api/wf/connectors/callback'

type ConnectorHandlerKeys =
  | 'getConnectorCapability'
  | 'listConnectors'
  | 'getConnector'
  | 'saveConnector'
  | 'deleteConnector'
  | 'setConnectorEnabled'
  | 'refreshConnector'
  | 'setConnectorToolEnabled'
  | 'setConnectorToolSideEffect'
  | 'startConnectorAuth'
  | 'saveConnectorToken'
  | 'disconnectConnector'

function requireStr(params: unknown, key: string): string {
  const value = (params as Record<string, unknown>)[key]
  if (typeof value !== 'string' || !value) {
    throw new BadRequestError(`\`${key}\` is required.`)
  }
  return value
}

function connectionInfo(
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

function summarize(
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
    color: connector.color,
    note: connector.note,
    lastRefreshedAt: toEpoch(connector.lastRefreshedAt),
    connection: connectionInfo(connection),
    toolCount: tools.length,
    enabledToolCount: tools.filter((t) => t.enabled).length,
  }
}

function toolInfo(row: ConnectorToolRow): ConnectorToolInfo {
  return {
    id: row.id,
    toolName: row.toolName,
    title: row.title,
    description: row.description,
    // Already JSON Schema on the wire from the server — no Zod conversion, and
    // therefore none of the per-request CPU cost that forced `listTools` to
    // memoize the host registry's schemas.
    inputSchema: (row.inputSchema as JsonSchema | null) ?? undefined,
    outputSchema: (row.outputSchema as JsonSchema | null) ?? undefined,
    enabled: row.enabled,
    sideEffect: row.sideEffect,
    sideEffectOverridden: row.sideEffectOverridden,
    missingSince: toEpoch(row.missingSince),
    lastSeenAt: toEpoch(row.lastSeenAt),
    schemaHash: row.schemaHash,
  }
}

export function buildConnectorHandlers<TDeps>(
  opts: CreateWfSdkHandlersOptions<TDeps>,
): Pick<WfHandlers, ConnectorHandlerKeys> {
  /**
   * The encryption key, or null when the host wired none.
   *
   * Null is a first-class answer, not an error: a deployment that hasn't
   * thought about key management gets connectors as read-only scaffolding
   * rather than silent token storage. Only the paths that actually touch a
   * credential demand it.
   */
  const secretFor = async (c: HandlerCtx): Promise<string | null> => {
    const resolve = opts.config.resolveConnectorSecret
    if (!resolve) return null
    return resolve({ env: await c.env() }) ?? null
  }

  const requireSecret = async (c: HandlerCtx): Promise<string> => {
    const secret = await secretFor(c)
    if (!secret) {
      throw new BadRequestError(
        'Connector credentials are not configured. Wire `resolveConnectorSecret` ' +
          'on the host config (a `WF_CONNECTOR_KEY` secret) before connecting.',
      )
    }
    return secret
  }

  const requireConnector = async (
    c: HandlerCtx,
    connectorId: string,
  ): Promise<ConnectorRow> => {
    const connector = await getConnector(c.db, connectorId)
    if (!connector) throw new NotFoundError(`Connector '${connectorId}'`)
    return connector
  }

  /**
   * The absolute URL the authorization server redirects back to.
   *
   * Derived from the REQUEST origin rather than configured, so the same code
   * works on localhost and in production without a second setting to keep in
   * sync — and so a deployment can't authorize against an origin it isn't
   * actually served from.
   */
  const callbackUrl = (c: HandlerCtx): string =>
    new URL(
      opts.connectorCallbackPath ?? DEFAULT_CALLBACK_PATH,
      new URL(c.req.url).origin,
    ).toString()

  return {
    getConnectorCapability: async (c) => ({
      credentialsConfigured: (await secretFor(c)) !== null,
    }),

    listConnectors: async (c) => {
      const [connectors, connections] = await Promise.all([
        listConnectors(c.db),
        listConnections(c.db),
      ])
      const byConnector = new Map(connections.map((r) => [r.connectorId, r]))
      return await Promise.all(
        connectors.map(async (connector) =>
          summarize(
            connector,
            byConnector.get(connector.id) ?? null,
            await listConnectorTools(c.db, connector.id),
          ),
        ),
      )
    },

    getConnector: async (c): Promise<ConnectorDetail> => {
      const connectorId = requireStr(c.params, 'connectorId')
      const connector = await requireConnector(c, connectorId)
      const [connection, tools] = await Promise.all([
        getConnection(c.db, connectorId),
        listConnectorTools(c.db, connectorId),
      ])
      return {
        connector: summarize(connector, connection, tools),
        tools: tools.map(toolInfo),
      }
    },

    saveConnector: async (c) => {
      const id = requireStr(c.params, 'id')
      if (!CONNECTOR_ID_PATTERN.test(id)) {
        throw new BadRequestError(
          `'${id}' is not a valid connector id. Use lowercase letters, digits ` +
            'and dashes — the id is embedded in every one of its tool ids.',
        )
      }
      const p = c.params as Record<string, unknown>
      // Validated here, at write time, and not merely relied upon at fetch
      // time: `global_fetch_strictly_public` is not enforced under wrangler
      // dev, so a private URL would pass every local test and fail only in
      // production. See `connectors/url.ts`.
      const url = assertConnectorUrl(requireStr(c.params, 'url'), {
        allowInsecure: opts.connectorAllowInsecureUrls,
      })
      const existing = await getConnector(c.db, id)

      await upsertConnector(c.db, {
        id,
        label: requireStr(c.params, 'label'),
        url,
        transport: p.transport as 'http' | 'sse' | undefined,
        authKind: p.authKind as 'oauth2' | 'bearer' | 'none' | undefined,
        scopes: (p.scopes as string | null | undefined) ?? null,
        enabled: existing?.enabled ?? true,
        icon: (p.icon as string | null | undefined) ?? null,
        iconName: (p.iconName as string | null | undefined) ?? null,
        color: (p.color as string | null | undefined) ?? null,
        note: (p.note as string | null | undefined) ?? null,
      })
      await c.change({
        entityKind: 'connector',
        entityId: id,
        action: existing ? 'update' : 'create',
        note: requireStr(c.params, 'label'),
      })
      return { ok: true as const }
    },

    deleteConnector: async (c) => {
      const connectorId = requireStr(c.params, 'connectorId')
      const connector = await requireConnector(c, connectorId)
      await deleteConnector(c.db, connectorId)
      await c.change({
        entityKind: 'connector',
        entityId: connectorId,
        action: 'archive',
        note: connector.label,
      })
      return { ok: true as const }
    },

    setConnectorEnabled: async (c) => {
      const connectorId = requireStr(c.params, 'connectorId')
      const enabled = (c.params as { enabled?: boolean }).enabled === true
      await requireConnector(c, connectorId)
      await setConnectorEnabled(c.db, { connectorId, enabled })
      await c.change({
        entityKind: 'connector',
        entityId: connectorId,
        action: enabled ? 'enable' : 'disable',
        fields: ['enabled'],
        before: { enabled: !enabled },
        after: { enabled },
      })
      return { ok: true as const }
    },

    refreshConnector: async (c) => {
      const connectorId = requireStr(c.params, 'connectorId')
      const connector = await requireConnector(c, connectorId)
      const secret = await requireSecret(c)

      // A server may expose its catalog unauthenticated, so a missing
      // credential is not fatal here — try, and let the server object.
      const credential = await resolveAccessToken({ db: c.db, connector, secret })
      const tools = await discoverTools({
        url: connector.url,
        transport: connector.transport,
        auth: credential
          ? {
              kind: 'bearer',
              token: credential.token,
              tokenType: credential.tokenType,
            }
          : { kind: 'none' },
      })

      const result = await upsertConnectorTools(c.db, connectorId, tools)
      const refreshedAt = new Date()
      await touchConnectorRefreshed(c.db, connectorId, refreshedAt)

      // One change row for the refresh, not one per tool: a catalog pull is a
      // single human action, and thirty rows would bury every other edit in the
      // activity feed.
      await c.change({
        entityKind: 'connector',
        entityId: connectorId,
        action: 'update',
        note:
          `Refreshed ${connector.label}: ${result.added.length} new, ` +
          `${result.updated.length} updated, ${result.missing.length} withdrawn` +
          (result.drifted.length > 0
            ? `, ${result.drifted.length} schema change(s)`
            : ''),
      })

      return {
        refreshedAt: refreshedAt.getTime(),
        added: result.added.length,
        updated: result.updated.length,
        missing: result.missing.length,
        drifted: result.drifted,
        toolCount: tools.length,
      }
    },

    setConnectorToolEnabled: async (c) => {
      const toolId = requireStr(c.params, 'toolId')
      const enabled = (c.params as { enabled?: boolean }).enabled === true
      await setConnectorToolEnabled(c.db, { toolId, enabled })
      await c.change({
        entityKind: 'connector_tool',
        entityId: toolId,
        action: enabled ? 'enable' : 'disable',
        fields: ['enabled'],
        before: { enabled: !enabled },
        after: { enabled },
        note: toolId,
      })
      return { ok: true as const }
    },

    setConnectorToolSideEffect: async (c) => {
      const toolId = requireStr(c.params, 'toolId')
      const sideEffect = (c.params as { sideEffect?: string }).sideEffect
      if (sideEffect !== 'read' && sideEffect !== 'write') {
        throw new BadRequestError("`sideEffect` must be 'read' or 'write'.")
      }
      await setConnectorToolSideEffect(c.db, { toolId, sideEffect })
      await c.change({
        entityKind: 'connector_tool',
        entityId: toolId,
        action: 'update',
        fields: ['sideEffect'],
        after: { sideEffect },
        note: toolId,
      })
      return { ok: true as const }
    },

    startConnectorAuth: async (c) => {
      const connectorId = requireStr(c.params, 'connectorId')
      const connector = await requireConnector(c, connectorId)
      if (connector.authKind !== 'oauth2') {
        throw new BadRequestError(
          `${connector.label} is configured for ${connector.authKind} auth, not OAuth.`,
        )
      }
      const secret = await requireSecret(c)
      return await beginAuthorization({
        db: c.db,
        connector,
        redirectUri: callbackUrl(c),
        secret,
        userId: c.ctx.userId,
        returnTo: (c.params as { returnTo?: string }).returnTo,
      })
    },

    saveConnectorToken: async (c) => {
      const connectorId = requireStr(c.params, 'connectorId')
      const token = requireStr(c.params, 'token')
      const connector = await requireConnector(c, connectorId)
      const secret = await requireSecret(c)
      await saveBearerToken({
        db: c.db,
        connectorId,
        token,
        secret,
        userId: c.ctx.userId,
      })
      await c.change({
        entityKind: 'connector',
        entityId: connectorId,
        action: 'update',
        note: `Connected ${connector.label} with an API token`,
      })
      return { ok: true as const }
    },

    disconnectConnector: async (c) => {
      const connectorId = requireStr(c.params, 'connectorId')
      const connector = await requireConnector(c, connectorId)
      await deleteConnection(c.db, connectorId)
      await c.change({
        entityKind: 'connector',
        entityId: connectorId,
        action: 'update',
        note: `Disconnected ${connector.label}`,
      })
      return { ok: true as const }
    },
  }
}
