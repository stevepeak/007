import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationFull,
  OAuthProtectedResourceMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

import type { WfDb } from '../storage/client'
import {
  consumeOauthState,
  createOauthState,
  getConnection,
  getConnectorClient,
  saveConnection,
  saveConnectorClient,
  setConnectionStatus,
  updateConnectionTokens,
  WORKSPACE_OWNER,
  type ConnectionOwner,
  type ConnectorConnectionRow,
  type ConnectorRow,
} from '../storage/data/connectors'

import { McpUnauthorizedError } from './client'
import { decryptSecret, encryptSecret } from './crypto'

// The OAuth half of a connector: discovery, registration, the authorization
// round trip, and keeping the resulting token alive.
//
// The SDK's `client/auth.js` primitives do the protocol work (RFC 9728 resource
// metadata, RFC 8414 server metadata, RFC 7591 dynamic registration, PKCE, the
// token grants). What this module owns is everything they deliberately leave to
// the application: WHERE the credential lives (D1, encrypted), WHO it belongs
// to, and what happens when two runs try to refresh it at the same moment.
//
// We do NOT implement the SDK's `OAuthClientProvider` and hand it to the
// transport. That interface assumes a client that can redirect a user agent
// mid-request and retry; our flow is a browser round trip through a host route,
// and the token is shared workspace state rather than per-process. Driving the
// primitives directly keeps the token lifecycle in one readable place instead
// of split across a callback interface.

/** How early, before real expiry, we treat a token as due for refresh. */
const REFRESH_SKEW_MS = 60_000

/** How long an authorization attempt may sit unredeemed. */
const AUTH_ATTEMPT_TTL_MS = 10 * 60_000

/** Thrown when a connector cannot be authorized — with a reason for the UI. */
export class ConnectorAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConnectorAuthError'
  }
}

export type ConnectorDiscovery = {
  /** The AS base URL the grant endpoints belong to. */
  authorizationServerUrl: string
  metadata: AuthorizationServerMetadata | undefined
  resourceMetadata: OAuthProtectedResourceMetadata | undefined
  /** RFC 8707 resource indicator — binds the token to THIS server. */
  resource: URL | undefined
  scopesSupported: string[] | undefined
}

/**
 * Resolve a server's authorization configuration.
 *
 * Protected-resource metadata first (that is the MCP-blessed path and it names
 * the authorization server), falling back to treating the MCP server's own
 * origin as the issuer — which is what servers that predate RFC 9728 expect.
 */
export async function discoverConnectorAuth(
  serverUrl: string,
): Promise<ConnectorDiscovery> {
  let resourceMetadata: OAuthProtectedResourceMetadata | undefined
  try {
    resourceMetadata = await discoverOAuthProtectedResourceMetadata(serverUrl)
  } catch {
    // No `.well-known/oauth-protected-resource`. Not fatal — fall through to
    // the origin-as-issuer assumption below.
  }

  const authorizationServerUrl =
    resourceMetadata?.authorization_servers?.[0] ?? new URL(serverUrl).origin

  let metadata: AuthorizationServerMetadata | undefined
  try {
    metadata = await discoverAuthorizationServerMetadata(authorizationServerUrl)
  } catch {
    // Leave undefined; the SDK's primitives fall back to the default endpoint
    // paths (`/authorize`, `/token`, `/register`) when metadata is absent.
  }

  return {
    authorizationServerUrl,
    metadata,
    resourceMetadata,
    resource: resourceMetadata?.resource
      ? new URL(resourceMetadata.resource)
      : new URL(serverUrl),
    scopesSupported:
      resourceMetadata?.scopes_supported ?? metadata?.scopes_supported,
  }
}

/**
 * The OAuth client for a connector, registering one if we don't have it yet.
 *
 * Registration is cached per connector and keyed on the issuer + redirect URI:
 * if either changes, the stored registration is meaningless and we register
 * again rather than sending an authorization request the AS will reject.
 */
async function ensureClient(
  db: WfDb,
  connector: ConnectorRow,
  discovery: ConnectorDiscovery,
  redirectUri: string,
  secret: string,
): Promise<OAuthClientInformationFull> {
  const existing = await getConnectorClient(db, connector.id)
  if (
    existing &&
    existing.redirectUri === redirectUri &&
    (!existing.issuer || existing.issuer === discovery.authorizationServerUrl)
  ) {
    return {
      client_id: existing.clientId,
      client_secret: existing.clientSecret
        ? await decryptSecret(existing.clientSecret, secret)
        : undefined,
      redirect_uris: [existing.redirectUri],
    }
  }

  let registered: OAuthClientInformationFull
  try {
    registered = await registerClient(discovery.authorizationServerUrl, {
      metadata: discovery.metadata,
      clientMetadata: {
        client_name: '007 Workflows',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      scope: connector.scopes ?? undefined,
    })
  } catch (err) {
    throw new ConnectorAuthError(
      `Could not register an OAuth client with ${discovery.authorizationServerUrl}. ` +
        `The server may not support dynamic client registration. ` +
        `Underlying error: ${(err as Error).message}`,
    )
  }

  await saveConnectorClient(db, {
    connectorId: connector.id,
    clientId: registered.client_id,
    clientSecret: registered.client_secret
      ? await encryptSecret(registered.client_secret, secret)
      : null,
    redirectUri,
    issuer: discovery.authorizationServerUrl,
    raw: registered,
  })
  return registered
}

/**
 * Start an authorization: returns the URL to send the browser to.
 *
 * The PKCE verifier is stored encrypted alongside a single-use `state`, so the
 * callback can finish the exchange without the browser ever carrying anything
 * secret.
 */
export async function beginAuthorization(input: {
  db: WfDb
  connector: ConnectorRow
  redirectUri: string
  secret: string
  userId?: string
  returnTo?: string
}): Promise<{ authorizationUrl: string }> {
  const { db, connector, redirectUri, secret } = input
  const discovery = await discoverConnectorAuth(connector.url)
  const client = await ensureClient(
    db,
    connector,
    discovery,
    redirectUri,
    secret,
  )

  const state = crypto.randomUUID().replaceAll('-', '')
  const { authorizationUrl, codeVerifier } = await startAuthorization(
    discovery.authorizationServerUrl,
    {
      metadata: discovery.metadata,
      clientInformation: client,
      redirectUrl: redirectUri,
      scope: connector.scopes ?? undefined,
      state,
      resource: discovery.resource,
    },
  )

  await createOauthState(db, {
    state,
    connectorId: connector.id,
    codeVerifier: await encryptSecret(codeVerifier, secret),
    redirectUri,
    tokenEndpoint:
      discovery.metadata?.token_endpoint ??
      `${discovery.authorizationServerUrl.replace(/\/$/, '')}/token`,
    issuer: discovery.authorizationServerUrl,
    scopes: connector.scopes ?? null,
    returnTo: input.returnTo ?? null,
    userId: input.userId ?? null,
    expiresAt: new Date(Date.now() + AUTH_ATTEMPT_TTL_MS),
  })

  return { authorizationUrl: authorizationUrl.toString() }
}

/**
 * Best-effort human label for whoever just authorized.
 *
 * Read from the `id_token`'s claims when the grant included one (Linear
 * advertises `openid` and `email`). The JWT signature is NOT verified, and does
 * not need to be: this value came straight back from the token endpoint over
 * TLS and is used only as a display string next to the connection. It never
 * grants anything.
 */
function accountLabelFrom(tokens: OAuthTokens): string | null {
  const idToken = (tokens as { id_token?: unknown }).id_token
  if (typeof idToken !== 'string') return null
  const payload = idToken.split('.')[1]
  if (!payload) return null
  try {
    const json = atob(payload.replaceAll('-', '+').replaceAll('_', '/'))
    const claims = JSON.parse(json) as {
      email?: string
      name?: string
      preferred_username?: string
    }
    return claims.email ?? claims.name ?? claims.preferred_username ?? null
  } catch {
    return null
  }
}

function expiresAtFrom(tokens: OAuthTokens): Date | null {
  return typeof tokens.expires_in === 'number'
    ? new Date(Date.now() + tokens.expires_in * 1000)
    : null
}

/**
 * Finish an authorization started by {@link beginAuthorization}.
 *
 * The `state` row is consumed (read-and-deleted) before anything else, so a
 * replayed callback fails here rather than minting a second credential.
 */
export async function completeAuthorization(input: {
  db: WfDb
  secret: string
  state: string
  code: string
  owner?: ConnectionOwner
}): Promise<{ connectorId: string; returnTo: string | null }> {
  const { db, secret } = input
  const attempt = await consumeOauthState(db, input.state)
  if (!attempt) {
    throw new ConnectorAuthError(
      'This authorization link has expired or was already used. Start again from the connectors page.',
    )
  }

  const client = await getConnectorClient(db, attempt.connectorId)
  if (!client) {
    throw new ConnectorAuthError(
      'The OAuth client registration for this connector is missing. Start again.',
    )
  }

  let tokens: OAuthTokens
  try {
    tokens = await exchangeAuthorization(attempt.issuer ?? '', {
      metadata: { token_endpoint: attempt.tokenEndpoint } as
        | AuthorizationServerMetadata
        | undefined,
      clientInformation: {
        client_id: client.clientId,
        client_secret: client.clientSecret
          ? await decryptSecret(client.clientSecret, secret)
          : undefined,
      },
      authorizationCode: input.code,
      codeVerifier: await decryptSecret(attempt.codeVerifier, secret),
      redirectUri: attempt.redirectUri,
    })
  } catch (err) {
    throw new ConnectorAuthError(
      `The authorization server rejected the token exchange: ${(err as Error).message}`,
    )
  }

  await saveConnection(db, {
    connectorId: attempt.connectorId,
    owner: input.owner ?? WORKSPACE_OWNER,
    accessToken: await encryptSecret(tokens.access_token, secret),
    refreshToken: tokens.refresh_token
      ? await encryptSecret(tokens.refresh_token, secret)
      : null,
    tokenType: tokens.token_type ?? 'Bearer',
    expiresAt: expiresAtFrom(tokens),
    scopes: tokens.scope ?? attempt.scopes ?? null,
    accountLabel: accountLabelFrom(tokens),
    connectedBy: attempt.userId,
  })

  return { connectorId: attempt.connectorId, returnTo: attempt.returnTo }
}

/** Store a pasted API key / PAT as a connector's credential. */
export async function saveBearerToken(input: {
  db: WfDb
  connectorId: string
  token: string
  secret: string
  userId?: string
  accountLabel?: string | null
  owner?: ConnectionOwner
}): Promise<void> {
  await saveConnection(input.db, {
    connectorId: input.connectorId,
    owner: input.owner ?? WORKSPACE_OWNER,
    accessToken: await encryptSecret(input.token, input.secret),
    // A pasted token has no refresh lineage and no stated expiry; it is valid
    // until the service says otherwise, which surfaces as a 401.
    refreshToken: null,
    expiresAt: null,
    accountLabel: input.accountLabel ?? null,
    connectedBy: input.userId ?? null,
  })
}

function needsRefresh(connection: ConnectorConnectionRow): boolean {
  if (!connection.expiresAt) return false
  return connection.expiresAt.getTime() - REFRESH_SKEW_MS <= Date.now()
}

/**
 * The usable access token for a connector, refreshing it if it is due.
 *
 * Returns null when the connector has no connection at all — the caller turns
 * that into "not connected" rather than an error, because it is a setup state,
 * not a failure.
 *
 * The refresh is guarded: two nodes of the same run can arrive here at the same
 * moment with the same expired token, and a refresh token is single-use. The
 * loser of the compare-and-swap does NOT retry the grant (its token is already
 * spent) — it re-reads the row the winner just wrote and uses that.
 */
export async function resolveAccessToken(input: {
  db: WfDb
  connector: ConnectorRow
  secret: string
  owner?: ConnectionOwner
}): Promise<{ token: string; tokenType: string } | null> {
  const { db, connector, secret } = input
  const owner = input.owner ?? WORKSPACE_OWNER
  const connection = await getConnection(db, connector.id, owner)
  if (!connection) return null

  if (connection.status === 'revoked') {
    throw new McpUnauthorizedError(
      `The ${connector.label} connection was revoked. Reconnect it from the connectors page.`,
    )
  }

  if (!needsRefresh(connection)) {
    return {
      token: await decryptSecret(connection.accessToken, secret),
      tokenType: connection.tokenType,
    }
  }

  if (!connection.refreshToken) {
    await setConnectionStatus(db, {
      connectionId: connection.id,
      status: 'expired',
      error: 'The access token expired and the server issued no refresh token.',
    })
    throw new McpUnauthorizedError(
      `The ${connector.label} connection has expired. Reconnect it from the connectors page.`,
    )
  }

  const client = await getConnectorClient(db, connector.id)
  if (!client) {
    throw new McpUnauthorizedError(
      `The ${connector.label} OAuth registration is missing. Reconnect it.`,
    )
  }

  let tokens: OAuthTokens
  try {
    tokens = await refreshAuthorization(client.issuer ?? connector.url, {
      clientInformation: {
        client_id: client.clientId,
        client_secret: client.clientSecret
          ? await decryptSecret(client.clientSecret, secret)
          : undefined,
      },
      refreshToken: await decryptSecret(connection.refreshToken, secret),
    })
  } catch (err) {
    await setConnectionStatus(db, {
      connectionId: connection.id,
      status: 'expired',
      error: `Token refresh failed: ${(err as Error).message}`,
    })
    throw new McpUnauthorizedError(
      `Could not refresh the ${connector.label} connection. Reconnect it from the connectors page.`,
    )
  }

  const won = await updateConnectionTokens(db, {
    connectionId: connection.id,
    expectedVersion: connection.tokenVersion,
    accessToken: await encryptSecret(tokens.access_token, secret),
    refreshToken: tokens.refresh_token
      ? await encryptSecret(tokens.refresh_token, secret)
      : null,
    expiresAt: expiresAtFrom(tokens),
    scopes: tokens.scope ?? undefined,
  })

  if (won) {
    return {
      token: tokens.access_token,
      tokenType: tokens.token_type ?? connection.tokenType,
    }
  }

  // Someone else refreshed while we were in flight. Their token is the live
  // one; ours may already have been rotated out from under us.
  const fresh = await getConnection(db, connector.id, owner)
  if (!fresh) {
    throw new McpUnauthorizedError(
      `The ${connector.label} connection disappeared mid-refresh.`,
    )
  }
  return {
    token: await decryptSecret(fresh.accessToken, secret),
    tokenType: fresh.tokenType,
  }
}
