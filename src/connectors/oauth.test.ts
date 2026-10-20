import { beforeEach, describe, expect, mock, test } from 'bun:test'

import type { WfDb } from '../storage/client'
import {
  createOauthState,
  getConnection,
  getConnector,
  saveConnection,
  saveConnectorClient,
  updateConnectionTokens,
  upsertConnector,
} from '../storage/data/connectors'
import { freshDb } from '../storage/db-test-helpers'

import { encryptSecret } from './crypto'

// A refresh token is single-use at providers that rotate it. Two callers that
// hit the same expired token at once both send it; the provider honours the
// first and rejects the second. The loser must pick up the winner's token, not
// mark a healthy connection expired.

const KEY = 'test-key-do-not-use-in-prod'

let db: WfDb
let onRefresh: (url: unknown, opts: unknown) => Promise<unknown>
let onExchange: (url: unknown, opts: unknown) => Promise<unknown>

// Discovery is answered locally: the authorization server lives on its own
// host with a non-default token endpoint, and the resource names the MCP URL.
const AS_URL = 'https://auth.acme.example'
const TOKEN_ENDPOINT = 'https://auth.acme.example/oauth2/token'
const sdkAuth = await import('@modelcontextprotocol/sdk/client/auth.js')
void mock.module('@modelcontextprotocol/sdk/client/auth.js', () => ({
  ...sdkAuth,
  discoverOAuthProtectedResourceMetadata: async () => ({
    resource: 'https://acme.example/mcp',
    authorization_servers: [AS_URL],
  }),
  discoverAuthorizationServerMetadata: async () => ({
    issuer: AS_URL,
    authorization_endpoint: `${AS_URL}/authorize`,
    token_endpoint: TOKEN_ENDPOINT,
    response_types_supported: ['code'],
  }),
  refreshAuthorization: (url: unknown, opts: unknown) => onRefresh(url, opts),
  exchangeAuthorization: (url: unknown, opts: unknown) => onExchange(url, opts),
}))

const { completeAuthorization, resolveAccessToken } = await import('./oauth')

beforeEach(async () => {
  db = freshDb()
  await upsertConnector(db, {
    id: 'acme',
    label: 'Acme',
    url: 'https://acme.example/mcp',
  })
  await saveConnectorClient(db, {
    connectorId: 'acme',
    clientId: 'client-1',
    redirectUri: 'https://host.example/callback',
    issuer: AS_URL,
  })
  await saveConnection(db, {
    connectorId: 'acme',
    accessToken: await encryptSecret('stale-access', KEY),
    refreshToken: await encryptSecret('refresh-1', KEY),
    expiresAt: new Date(Date.now() - 60_000),
  })
})

async function resolve() {
  const connector = await getConnector(db, 'acme')
  return await resolveAccessToken({ db, connector: connector!, secret: KEY })
}

describe('resolveAccessToken when the refresh is rejected', () => {
  test('uses the token a concurrent refresh already stored', async () => {
    onRefresh = async () => {
      // The winner lands its rotation while our request is in flight.
      const row = await getConnection(db, 'acme')
      await updateConnectionTokens(db, {
        connectionId: row!.id,
        expectedVersion: row!.tokenVersion,
        accessToken: await encryptSecret('winner-access', KEY),
        refreshToken: await encryptSecret('refresh-2', KEY),
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      throw new Error('invalid_grant')
    }

    expect(await resolve()).toEqual({
      token: 'winner-access',
      tokenType: 'Bearer',
    })
    const row = await getConnection(db, 'acme')
    expect(row!.status).toBe('connected')
    expect(row!.lastError).toBeNull()
  })

  test('marks the connection expired when nobody else refreshed', async () => {
    onRefresh = () => Promise.reject(new Error('invalid_grant'))

    await expect(resolve()).rejects.toThrow(/Could not refresh the Acme/)
    const row = await getConnection(db, 'acme')
    expect(row!.status).toBe('expired')
    expect(row!.lastError).toContain('invalid_grant')
  })
})

describe('token grants use the discovered server', () => {
  test('a refresh sends the discovered token endpoint and the resource', async () => {
    let seen: { url: unknown; opts: Record<string, unknown> } | undefined
    onRefresh = async (url, opts) => {
      seen = { url, opts: opts as Record<string, unknown> }
      return { access_token: 'fresh', token_type: 'Bearer', expires_in: 3600 }
    }

    expect(await resolve()).toEqual({ token: 'fresh', tokenType: 'Bearer' })
    expect(seen?.url).toBe(AS_URL)
    expect((seen?.opts.metadata as { token_endpoint: string }).token_endpoint).toBe(
      TOKEN_ENDPOINT,
    )
    expect(String(seen?.opts.resource)).toBe('https://acme.example/mcp')
  })

  test('the exchange sends the resource, and a UTF-8 account label survives', async () => {
    let seen: Record<string, unknown> | undefined
    const claims = { name: 'Zoë Ñúñez' }
    const payload = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(claims))))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '')
    onExchange = async (_url, opts) => {
      seen = opts as Record<string, unknown>
      return { access_token: 'a', token_type: 'Bearer', id_token: `h.${payload}.s` }
    }
    await createOauthState(db, {
      state: 'st-1',
      connectorId: 'acme',
      codeVerifier: await encryptSecret('verifier', KEY),
      redirectUri: 'https://host.example/callback',
      tokenEndpoint: TOKEN_ENDPOINT,
      issuer: AS_URL,
      expiresAt: new Date(Date.now() + 60_000),
    })

    await completeAuthorization({ db, secret: KEY, state: 'st-1', code: 'c' })
    expect(String(seen?.resource)).toBe('https://acme.example/mcp')
    const row = await getConnection(db, 'acme')
    expect(row!.accountLabel).toBe('Zoë Ñúñez')
  })
})
