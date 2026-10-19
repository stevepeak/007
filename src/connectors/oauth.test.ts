import { beforeEach, describe, expect, mock, test } from 'bun:test'

import type { WfDb } from '../storage/client'
import {
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
let onRefresh: () => Promise<never>

const sdkAuth = await import('@modelcontextprotocol/sdk/client/auth.js')
void mock.module('@modelcontextprotocol/sdk/client/auth.js', () => ({
  ...sdkAuth,
  refreshAuthorization: () => onRefresh(),
}))

const { resolveAccessToken } = await import('./oauth')

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
