import { describe, expect, test } from 'bun:test'

import {
  getConnection,
  getConnector,
  setConnectionStatus,
  upsertConnector,
} from '../storage/data/connectors'
import { freshDb } from '../storage/db-test-helpers'

import { McpUnauthorizedError, type McpAuth } from './client'
import { saveBearerToken } from './oauth'
import { withConnectorAuth } from './session'

const SECRET = 'test-key-do-not-use-in-prod'

async function setup(args: { connected: boolean }) {
  const db = freshDb()
  await upsertConnector(db, {
    id: 'acme',
    label: 'Acme',
    url: 'https://mcp.example.com',
    authKind: 'bearer',
  })
  if (args.connected) {
    await saveBearerToken({
      db,
      connectorId: 'acme',
      token: 'tok',
      secret: SECRET,
    })
  }
  const connector = (await getConnector(db, 'acme'))!
  return { db, connector }
}

describe('withConnectorAuth', () => {
  test('passes the stored token as bearer auth', async () => {
    const { db, connector } = await setup({ connected: true })
    let seen: McpAuth | undefined
    await withConnectorAuth({
      db,
      connector,
      secret: SECRET,
      requireCredential: true,
      run: (auth) => {
        seen = auth
        return Promise.resolve(null)
      },
    })
    expect(seen).toEqual({ kind: 'bearer', token: 'tok' })
  })

  test('no credential: required → unauthorized, optional → no auth', async () => {
    const { db, connector } = await setup({ connected: false })
    const base = { db, connector, secret: SECRET }
    await expect(
      withConnectorAuth({
        ...base,
        requireCredential: true,
        run: () => Promise.resolve(null),
      }),
    ).rejects.toThrow(McpUnauthorizedError)
    let seen: McpAuth | undefined
    await withConnectorAuth({
      ...base,
      requireCredential: false,
      run: (auth) => {
        seen = auth
        return Promise.resolve(null)
      },
    })
    expect(seen).toEqual({ kind: 'none' })
  })

  test('a 401 marks the connection expired; a later success clears it', async () => {
    const { db, connector } = await setup({ connected: true })
    const base = { db, connector, secret: SECRET, requireCredential: true }
    await expect(
      withConnectorAuth({
        ...base,
        run: () => Promise.reject(new McpUnauthorizedError('401')),
      }),
    ).rejects.toThrow('401')
    expect((await getConnection(db, 'acme'))?.status).toBe('expired')

    // `resolveAccessToken` still hands out an expired bearer token (only
    // `revoked` refuses), so the next call goes through and recovers.
    await withConnectorAuth({ ...base, run: () => Promise.resolve('ok') })
    expect((await getConnection(db, 'acme'))?.status).toBe('connected')
  })

  test('a revoked connection is not revived', async () => {
    const { db, connector } = await setup({ connected: true })
    const connection = (await getConnection(db, 'acme'))!
    await setConnectionStatus(db, {
      connectionId: connection.id,
      status: 'revoked',
      error: null,
    })
    await expect(
      withConnectorAuth({
        db,
        connector,
        secret: SECRET,
        requireCredential: true,
        run: () => Promise.resolve('ok'),
      }),
    ).rejects.toThrow(McpUnauthorizedError)
  })
})
