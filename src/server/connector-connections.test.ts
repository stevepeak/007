import { afterEach, describe, expect, spyOn, test } from 'bun:test'

import { saveBearerToken } from '../connectors/oauth'
import { withRunConnectors } from '../connectors/registry'
import type { WfSdkConfig } from '../engine/config'
import {
  getConnection,
  getConnector,
  upsertConnector,
  upsertConnectorTools,
} from '../storage/data/connectors'
import { freshDb } from '../storage/db-test-helpers'

import {
  disconnectOwnerConnector,
  ensureConnector,
  listOwnerConnectors,
  ownerConnectorFetch,
} from './connector-connections'

const SECRET = 'test-key-do-not-use-in-prod'
const brandA = { scope: 'tenant', id: 'brand-a' } as const
const brandB = { scope: 'tenant', id: 'brand-b' } as const

async function setup() {
  const db = freshDb()
  await upsertConnector(db, {
    id: 'acme',
    label: 'Acme',
    url: 'https://mcp.example.com',
    authKind: 'bearer',
  })
  await saveBearerToken({
    db,
    connectorId: 'acme',
    token: 'tok-a',
    secret: SECRET,
    accountLabel: 'a@acme',
    owner: brandA,
  })
  return db
}

describe('per-owner connections', () => {
  test("lists each owner's own connection only", async () => {
    const db = await setup()
    const [forA] = await listOwnerConnectors({ db, owner: brandA })
    const [forB] = await listOwnerConnectors({ db, owner: brandB })
    expect(forA?.connection?.accountLabel).toBe('a@acme')
    expect(forB?.connection).toBeNull()
  })

  test("disconnecting one owner keeps the others'", async () => {
    const db = await setup()
    await saveBearerToken({
      db,
      connectorId: 'acme',
      token: 'tok-b',
      secret: SECRET,
      owner: brandB,
    })
    await disconnectOwnerConnector({ db, connectorId: 'acme', owner: brandA })
    expect(await getConnection(db, 'acme', brandA)).toBeNull()
    expect(await getConnection(db, 'acme', brandB)).not.toBeNull()
  })

  // An admin may have tuned an existing connector; setup must not undo it.
  test('ensureConnector creates once and never overwrites', async () => {
    const db = await setup()
    await ensureConnector({
      db,
      id: 'acme',
      label: 'Renamed',
      url: 'https://elsewhere.example.com',
    })
    expect((await getConnector(db, 'acme'))?.label).toBe('Acme')

    await ensureConnector({
      db,
      id: 'zernio',
      label: 'Zernio',
      url: 'https://mcp.zernio.com/mcp',
    })
    expect((await getConnector(db, 'zernio'))?.authKind).toBe('oauth2')
  })
})

describe('ownerConnectorFetch', () => {
  const fetchSpy = spyOn(globalThis, 'fetch')
  afterEach(() => fetchSpy.mockReset())

  test("sends the owner's token to the service's own API", async () => {
    const db = await setup()
    fetchSpy.mockResolvedValue(Response.json({ ok: true }))
    const response = await ownerConnectorFetch({
      db,
      secret: SECRET,
      connectorId: 'acme',
      owner: brandA,
      url: 'https://api.example.com/v1/things',
    })
    expect(await response.json()).toEqual({ ok: true })
    const [, init] = fetchSpy.mock.calls[0] ?? []
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer tok-a')
  })

  test('a 401 marks the connection expired', async () => {
    const db = await setup()
    fetchSpy.mockResolvedValue(new Response(null, { status: 401 }))
    const call = ownerConnectorFetch({
      db,
      secret: SECRET,
      connectorId: 'acme',
      owner: brandA,
      url: 'https://api.example.com/v1/things',
    })
    await expect(call).rejects.toThrow('rejected')
    expect((await getConnection(db, 'acme', brandA))?.status).toBe('expired')
  })

  test('an owner with no connection fails before calling out', async () => {
    const db = await setup()
    const call = ownerConnectorFetch({
      db,
      secret: SECRET,
      connectorId: 'acme',
      owner: brandB,
      url: 'https://api.example.com/v1/things',
    })
    await expect(call).rejects.toThrow('not connected')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('a run uses the owner the host resolves', () => {
  test("a brand's run fails on a brand with no connection, naming it", async () => {
    const db = await setup()
    await upsertConnectorTools(db, 'acme', [
      { name: 'post', sideEffect: 'write', schemaHash: 'h' },
    ])
    const config = {
      toolRegistry: new Map(),
      resolveConnectorSecret: () => SECRET,
      resolveConnectionOwner: (ctx) => {
        const id = ctx.hostContext?.brandId
        return id ? { scope: 'tenant', id } : undefined
      },
    } as Partial<WfSdkConfig<unknown>> as WfSdkConfig<unknown>

    const runConfig = await withRunConnectors({
      config,
      env: {},
      runContext: { triggerKind: 'test', hostContext: { brandId: 'brand-b' } },
      resolveDb: () => db,
    })
    const entry = runConfig.toolRegistry.get('mcp:acme:post')
    if (entry?.kind !== 'ai-tool') throw new Error('expected an ai-tool')
    const built = entry.build(undefined) as {
      execute: (args: unknown, opts: unknown) => Promise<unknown>
    }
    await expect(
      built.execute({}, { toolCallId: 't', messages: [] }),
    ).rejects.toThrow("Acme is not connected for tenant 'brand-b'")
  })
})
