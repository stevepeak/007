import { saveBearerToken } from '../../connectors/oauth'
import { assertConnectorUrl } from '../../connectors/url'
import type { JsonSchema } from '../../engine/agent-output'
import { WORKSPACE_CONNECTION_OWNER } from '../../engine/connection-owner'
import {
  CONNECTOR_ID_PATTERN,
  slugifyConnectorId,
} from '../../engine/connector-tool-id'
import {
  deleteAllConnections,
  deleteConnector,
  getConnection,
  getConnector,
  listConnectors,
  listConnectorTools,
  setConnectorEnabled,
  setConnectorToolEnabled,
  setConnectorToolSideEffect,
  upsertConnector,
  type ConnectorRow,
  type ConnectorToolRow,
} from '../../storage/data/connectors'
import {
  disconnectOwnerConnector,
  listOwnerConnectors,
  refreshConnectorCatalog,
  startOwnerConnectorAuth,
  toConnectorSummary,
} from '../connector-connections'
import type { ConnectorDetail, ConnectorToolInfo } from '../protocol-connectors'

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
// The connectors page manages the WORKSPACE credential; per-tenant credentials
// go through `../connector-connections` from the host's own routes. The
// owner-aware logic lives there and these handlers pin it to the workspace.
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

  /** `base`, or the first `base-N` that no connector already holds. */
  const uniqueConnectorId = async (
    c: HandlerCtx,
    base: string,
  ): Promise<string> => {
    const taken = new Set((await listConnectors(c.db)).map((r) => r.id))
    if (!taken.has(base)) return base
    for (let n = 2; ; n++) {
      // Keep the suffix inside the 63-char cap the pattern enforces.
      const candidate = `${base.slice(0, 63 - `-${n}`.length)}-${n}`
      if (!taken.has(candidate)) return candidate
    }
  }

  /**
   * The absolute URL the authorization server redirects back to.
   *
   * Derived from the REQUEST origin rather than configured, so the same code
   * works on localhost and in production without a second setting to keep in
   * sync — and so a deployment can't authorize against an origin it isn't
   * actually served from.
   */
  const callbackUrl = (c: HandlerCtx): string => { return new URL(
      opts.connectorCallbackPath ?? DEFAULT_CALLBACK_PATH,
      new URL(c.req.url).origin,
    ).href }

  return {
    getConnectorCapability: async (c) => ({
      credentialsConfigured: (await secretFor(c)) !== null,
    }),

    listConnectors: async (c) => {
      return await listOwnerConnectors({
        db: c.db,
        owner: WORKSPACE_CONNECTION_OWNER,
      })
    },

    getConnector: async (c): Promise<ConnectorDetail> => {
      const { connectorId } = c.params
      const connector = await requireConnector(c, connectorId)
      const [connection, tools] = await Promise.all([
        getConnection(c.db, connectorId),
        listConnectorTools(c.db, connectorId),
      ])
      return {
        connector: toConnectorSummary(connector, connection, tools),
        tools: tools.map(toolInfo),
      }
    },

    saveConnector: async (c) => {
      const p = c.params
      const { label } = p
      // No id = create, and the id is ours to pick. It is derived from the
      // label and de-duplicated (`linear`, `linear-2`, …) rather than asked
      // for: it is internal, permanent, and nothing a human would type beats
      // the label's slug. An id IS accepted, for wf-spec imports that must
      // land on a known slug — and it still has to be well-formed.
      const id = p.id || (await uniqueConnectorId(c, slugifyConnectorId(label)))
      if (!CONNECTOR_ID_PATTERN.test(id)) {
        throw new BadRequestError(
          `'${id}' is not a valid connector id. Use lowercase letters, digits ` +
            'and dashes — the id is embedded in every one of its tool ids.',
        )
      }
      // Validated here, at write time, and not merely relied upon at fetch
      // time: `global_fetch_strictly_public` is not enforced under wrangler
      // dev, so a private URL would pass every local test and fail only in
      // production. See `connectors/url.ts`.
      const url = assertConnectorUrl(p.url, {
        allowInsecure: opts.connectorAllowInsecureUrls,
      })
      const existing = await getConnector(c.db, id)
      const authKind = p.authKind ?? existing?.authKind ?? 'oauth2'

      await upsertConnector(c.db, {
        id,
        label,
        url,
        transport: p.transport ?? existing?.transport,
        authKind,
        scopes: p.scopes ?? null,
        enabled: existing?.enabled ?? true,
        icon: p.icon ?? existing?.icon ?? null,
        iconName: p.iconName ?? existing?.iconName ?? null,
        color: p.color ?? existing?.color ?? null,
        note: p.note ?? null,
      })

      // A credential is issued by ONE server for ONE auth scheme. Re-pointing
      // the connector at a different URL, or switching how it authenticates,
      // would otherwise send the old token to the new host on the next call —
      // so the edit disconnects EVERY owner, not just the workspace, and each
      // has to sign in again.
      const credentialInvalidated =
        !!existing && (existing.url !== url || existing.authKind !== authKind)
      if (credentialInvalidated) await deleteAllConnections(c.db, id)

      await c.change({
        entityKind: 'connector',
        entityId: id,
        action: existing ? 'update' : 'create',
        note: credentialInvalidated
          ? `${label} — server changed, disconnected`
          : label,
      })
      return { ok: true as const, id, disconnected: credentialInvalidated }
    },

    deleteConnector: async (c) => {
      const { connectorId } = c.params
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
      const { connectorId, enabled } = c.params
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
      const { connectorId } = c.params
      const { label, ...result } = await refreshConnectorCatalog({
        db: c.db,
        secret: await requireSecret(c),
        connectorId,
        owner: WORKSPACE_CONNECTION_OWNER,
      })

      // One change row for the refresh, not one per tool: a catalog pull is a
      // single human action, and thirty rows would bury every other edit in the
      // activity feed.
      await c.change({
        entityKind: 'connector',
        entityId: connectorId,
        action: 'update',
        note:
          `Refreshed ${label}: ${result.added} new, ` +
          `${result.updated} updated, ${result.missing} withdrawn` +
          (result.drifted.length > 0
            ? `, ${result.drifted.length} schema change(s)`
            : ''),
      })

      return result
    },

    setConnectorToolEnabled: async (c) => {
      const { toolId, enabled } = c.params
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
      // No 'read' | 'write' re-check here: the schema's `z.enum` already
      // rejected anything else with a 400 before this ran.
      const { toolId, sideEffect } = c.params
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
      return await startOwnerConnectorAuth({
        db: c.db,
        secret: await requireSecret(c),
        connectorId: c.params.connectorId,
        owner: WORKSPACE_CONNECTION_OWNER,
        redirectUri: callbackUrl(c),
        userId: c.ctx.userId,
        returnTo: c.params.returnTo,
      })
    },

    saveConnectorToken: async (c) => {
      const { connectorId, token } = c.params
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
      const { connectorId } = c.params
      const connector = await requireConnector(c, connectorId)
      await disconnectOwnerConnector({
        db: c.db,
        connectorId,
        owner: WORKSPACE_CONNECTION_OWNER,
      })
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
