import { beforeEach, describe, expect, test } from 'bun:test'

import type { WfDb } from '../../storage/client'
import {
  getConnection,
  getConnector,
  saveConnection,
  upsertConnector,
} from '../../storage/data/connectors'
import { freshDb } from '../../storage/db-test-helpers'

import { buildConnectorHandlers } from './connectors'
import { testHandlerCtx, testHandlerOptions } from './handler-test-helpers'

// `saveConnector` as an EDIT. Creating is the easy half; the rule worth pinning
// is that re-pointing a connector at a different server, or switching how it
// authenticates, drops the stored credential — a token issued by one server
// must never be presented to another. Cosmetic edits keep the connection.

const BASE = {
  id: 'linear',
  label: 'Linear',
  url: 'https://mcp.linear.app/mcp',
  authKind: 'oauth2' as const,
  scopes: 'read',
}

let db: WfDb
const handlers = buildConnectorHandlers(
  testHandlerOptions({ config: { toolRegistry: new Map() } }),
)

beforeEach(async () => {
  db = freshDb()
  await upsertConnector(db, { ...BASE, note: 'Team workspace', color: '#5e6ad2' })
  await saveConnection(db, { connectorId: 'linear', accessToken: 'ct:abc' })
})

describe('saveConnector (edit)', () => {
  test('a cosmetic edit keeps the credential and the fields it did not send', async () => {
    const result = await handlers.saveConnector(
      testHandlerCtx(db, { ...BASE, label: 'Linear (prod)', scopes: 'read write' }),
    )
    expect(result).toEqual({ ok: true, id: 'linear', disconnected: false })

    const row = await getConnector(db, 'linear')
    expect(row?.label).toBe('Linear (prod)')
    expect(row?.scopes).toBe('read write')
    // The form doesn't carry `color`; an edit must not blank what it doesn't
    // know about.
    expect(row?.color).toBe('#5e6ad2')
    expect(await getConnection(db, 'linear')).not.toBeNull()
  })

  test('changing the server URL drops the credential', async () => {
    const result = await handlers.saveConnector(
      testHandlerCtx(db, { ...BASE, url: 'https://mcp.example.com/mcp' }),
    )
    expect(result).toEqual({ ok: true, id: 'linear', disconnected: true })
    expect((await getConnector(db, 'linear'))?.url).toBe(
      'https://mcp.example.com/mcp',
    )
    expect(await getConnection(db, 'linear')).toBeNull()
  })

  test('changing the auth kind drops the credential', async () => {
    const result = await handlers.saveConnector(
      testHandlerCtx(db, { ...BASE, authKind: 'bearer' }),
    )
    expect(result).toEqual({ ok: true, id: 'linear', disconnected: true })
    expect(await getConnection(db, 'linear')).toBeNull()
  })

  test('creating a connector reports nothing to disconnect', async () => {
    const result = await handlers.saveConnector(
      testHandlerCtx(db, { ...BASE, id: 'github', url: 'https://api.githubcopilot.com/mcp/' }),
    )
    expect(result).toEqual({ ok: true, id: 'github', disconnected: false })
  })
})

describe('saveConnector (create without an id)', () => {
  const create = (label: string) => { return handlers.saveConnector(
      testHandlerCtx(db, { label, url: 'https://mcp.example.com/mcp', authKind: 'none' }),
    ) }

  test('derives the id from the label', async () => {
    const result = await create('GitHub (prod)')
    expect(result.id).toBe('github-prod')
    expect((await getConnector(db, 'github-prod'))?.label).toBe('GitHub (prod)')
  })

  test('a label whose slug is taken gets a numbered suffix, not an overwrite', async () => {
    // `linear` already exists from beforeEach, with a credential attached.
    const result = await create('Linear')
    expect(result.id).toBe('linear-2')
    // The original is untouched — in particular still connected.
    expect((await getConnector(db, 'linear'))?.url).toBe(BASE.url)
    expect(await getConnection(db, 'linear')).not.toBeNull()

    expect((await create('Linear')).id).toBe('linear-3')
  })

  test('a label with nothing usable in it still yields a valid id', async () => {
    expect((await create('🚀')).id).toBe('connector')
    expect((await create('🚀')).id).toBe('connector-2')
  })
})
