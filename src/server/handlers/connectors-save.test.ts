import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import { consoleWfLogger } from '../../engine/logger'
import type { WfDb } from '../../storage/client'
import { recordChange } from '../../storage/data'
import {
  getConnection,
  getConnector,
  saveConnection,
  upsertConnector,
} from '../../storage/data/connectors'
import { wfSchema } from '../../storage/schema'

import { buildConnectorHandlers } from './connectors'
import type { CreateWfSdkHandlersOptions, HandlerCtx } from './shared'

// `saveConnector` as an EDIT. Creating is the easy half; the rule worth pinning
// is that re-pointing a connector at a different server, or switching how it
// authenticates, drops the stored credential — a token issued by one server
// must never be presented to another. Cosmetic edits keep the connection.

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../migrations', import.meta.url),
)

function freshDb(): WfDb {
  const sqlite = new Database(':memory:')
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const f of files) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${f}`, 'utf8')
    for (const stmt of sql.split('--> statement-breakpoint')) {
      const trimmed = stmt.trim()
      if (trimmed) sqlite.run(trimmed)
    }
  }
  return drizzle(sqlite, { schema: wfSchema }) as unknown as WfDb
}

function options(): CreateWfSdkHandlersOptions<unknown> {
  return {
    config: { toolRegistry: new Map(), listModels: async () => [] },
    resolveDb: () => {
      throw new Error('unused')
    },
    resolveContext: () => ({}),
  } as unknown as CreateWfSdkHandlersOptions<unknown>
}

function ctx(db: WfDb, params: unknown): HandlerCtx {
  return {
    params,
    ctx: { userId: 'tester' },
    db,
    req: new Request('http://localhost/api/wf', { method: 'POST' }),
    env: async () => ({}),
    analytics: async () => null,
    logger: consoleWfLogger,
    change: (input) => {
      return recordChange(db, { ...input, actor: { userId: 'tester' } })
    },
  }
}

const BASE = {
  id: 'linear',
  label: 'Linear',
  url: 'https://mcp.linear.app/mcp',
  authKind: 'oauth2' as const,
  scopes: 'read',
}

let db: WfDb
const handlers = buildConnectorHandlers(options())

beforeEach(async () => {
  db = freshDb()
  await upsertConnector(db, { ...BASE, note: 'Team workspace', color: '#5e6ad2' })
  await saveConnection(db, { connectorId: 'linear', accessToken: 'ct:abc' })
})

describe('saveConnector (edit)', () => {
  test('a cosmetic edit keeps the credential and the fields it did not send', async () => {
    const result = await handlers.saveConnector(
      ctx(db, { ...BASE, label: 'Linear (prod)', scopes: 'read write' }),
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
      ctx(db, { ...BASE, url: 'https://mcp.example.com/mcp' }),
    )
    expect(result).toEqual({ ok: true, id: 'linear', disconnected: true })
    expect((await getConnector(db, 'linear'))?.url).toBe(
      'https://mcp.example.com/mcp',
    )
    expect(await getConnection(db, 'linear')).toBeNull()
  })

  test('changing the auth kind drops the credential', async () => {
    const result = await handlers.saveConnector(
      ctx(db, { ...BASE, authKind: 'bearer' }),
    )
    expect(result).toEqual({ ok: true, id: 'linear', disconnected: true })
    expect(await getConnection(db, 'linear')).toBeNull()
  })

  test('creating a connector reports nothing to disconnect', async () => {
    const result = await handlers.saveConnector(
      ctx(db, { ...BASE, id: 'github', url: 'https://api.githubcopilot.com/mcp/' }),
    )
    expect(result).toEqual({ ok: true, id: 'github', disconnected: false })
  })
})

describe('saveConnector (create without an id)', () => {
  const create = (label: string) =>
    handlers.saveConnector(
      ctx(db, { label, url: 'https://mcp.example.com/mcp', authKind: 'none' }),
    )

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
