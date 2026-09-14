import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import { isEncrypted } from '../../connectors/crypto'
import type { WfDb } from '../client'
import { wfSchema } from '../schema'

import {
  consumeOauthState,
  createOauthState,
  deleteConnector,
  getConnection,
  getConnectorTool,
  listConnectorTools,
  listEnabledConnectorTools,
  saveConnection,
  saveConnectorClient,
  setConnectorEnabled,
  setConnectorToolEnabled,
  setConnectorToolSideEffect,
  updateConnectionTokens,
  upsertConnector,
  upsertConnectorTools,
  type DiscoveredTool,
} from './connectors'

// Runs against the real migrations, so these also assert that 0030 applies.
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

let db: WfDb
beforeEach(async () => {
  db = freshDb()
  await upsertConnector(db, {
    id: 'linear',
    label: 'Linear',
    url: 'https://mcp.linear.app/mcp',
  })
})

function tool(name: string, over: Partial<DiscoveredTool> = {}): DiscoveredTool {
  return {
    name,
    description: `the ${name} tool`,
    inputSchema: { type: 'object' },
    sideEffect: 'write',
    schemaHash: `hash-${name}`,
    ...over,
  }
}

describe('tool catalog refresh', () => {
  // The single most important property of the whole feature: connecting a
  // server must not make anything callable. A server ships write tools, and a
  // refresh that enabled them would widen every agent's reach silently.
  test('new tools arrive disabled', async () => {
    const result = await upsertConnectorTools(db, 'linear', [
      tool('list_issues'),
      tool('create_issue'),
    ])
    expect(result.added.sort()).toEqual([
      'mcp:linear:create_issue',
      'mcp:linear:list_issues',
    ])
    const rows = await listConnectorTools(db, 'linear')
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => !r.enabled)).toBe(true)
    expect(await listEnabledConnectorTools(db)).toEqual([])
  })

  test('a refresh preserves what a human enabled', async () => {
    await upsertConnectorTools(db, 'linear', [tool('list_issues')])
    await setConnectorToolEnabled(db, {
      toolId: 'mcp:linear:list_issues',
      enabled: true,
    })

    await upsertConnectorTools(db, 'linear', [
      tool('list_issues', { description: 'now with a better description' }),
    ])

    const [row] = await listConnectorTools(db, 'linear')
    expect(row.enabled).toBe(true)
    expect(row.description).toBe('now with a better description')
  })

  // The server's annotation is a hint; a human who read the docs outranks it,
  // and the next refresh must not quietly revert their call.
  test('a refresh preserves a side-effect override', async () => {
    await upsertConnectorTools(db, 'linear', [
      tool('search', { sideEffect: 'write' }),
    ])
    await setConnectorToolSideEffect(db, {
      toolId: 'mcp:linear:search',
      sideEffect: 'read',
    })

    await upsertConnectorTools(db, 'linear', [
      tool('search', { sideEffect: 'write' }),
    ])

    const [row] = await listConnectorTools(db, 'linear')
    expect(row.sideEffect).toBe('read')
    expect(row.sideEffectOverridden).toBe(true)
  })

  // Without an override, the server stays the source of truth.
  test('a refresh tracks the server when nobody overrode it', async () => {
    await upsertConnectorTools(db, 'linear', [
      tool('search', { sideEffect: 'write' }),
    ])
    await upsertConnectorTools(db, 'linear', [
      tool('search', { sideEffect: 'read' }),
    ])
    const [row] = await listConnectorTools(db, 'linear')
    expect(row.sideEffect).toBe('read')
  })

  test('reports which tools drifted', async () => {
    await upsertConnectorTools(db, 'linear', [tool('a'), tool('b')])
    const result = await upsertConnectorTools(db, 'linear', [
      tool('a', { schemaHash: 'hash-a-CHANGED' }),
      tool('b'),
    ])
    expect(result.drifted).toEqual(['mcp:linear:a'])
    expect(result.added).toEqual([])
    expect(result.updated.sort()).toEqual(['mcp:linear:a', 'mcp:linear:b'])
  })

  // A withdrawn tool is marked, not deleted: an agent may still reference it,
  // and "the server withdrew this" beats an unresolvable id.
  test('marks vanished tools missing rather than deleting them', async () => {
    await upsertConnectorTools(db, 'linear', [tool('a'), tool('b')])
    await setConnectorToolEnabled(db, { toolId: 'mcp:linear:b', enabled: true })

    const result = await upsertConnectorTools(db, 'linear', [tool('a')])
    expect(result.missing).toEqual(['mcp:linear:b'])

    const rows = await listConnectorTools(db, 'linear')
    expect(rows).toHaveLength(2)
    const b = rows.find((r) => r.id === 'mcp:linear:b')
    expect(b?.missingSince).toBeTruthy()
    // Still enabled, but no longer resolvable — it cannot be called.
    expect(b?.enabled).toBe(true)
    expect(await listEnabledConnectorTools(db)).toEqual([])
  })

  test('a returning tool is no longer missing', async () => {
    await upsertConnectorTools(db, 'linear', [tool('a')])
    await upsertConnectorTools(db, 'linear', [])
    await upsertConnectorTools(db, 'linear', [tool('a')])
    const [row] = await listConnectorTools(db, 'linear')
    expect(row.missingSince).toBeNull()
  })

  test('already-missing tools are not re-reported on every refresh', async () => {
    await upsertConnectorTools(db, 'linear', [tool('a')])
    expect((await upsertConnectorTools(db, 'linear', [])).missing).toEqual([
      'mcp:linear:a',
    ])
    expect((await upsertConnectorTools(db, 'linear', [])).missing).toEqual([])
  })
})

describe('what is callable', () => {
  beforeEach(async () => {
    await upsertConnectorTools(db, 'linear', [tool('a'), tool('b')])
    await setConnectorToolEnabled(db, { toolId: 'mcp:linear:a', enabled: true })
  })

  test('an enabled tool on an enabled connector resolves', async () => {
    const rows = await listEnabledConnectorTools(db)
    expect(rows.map((r) => r.tool.id)).toEqual(['mcp:linear:a'])
    expect(rows[0].connector.label).toBe('Linear')
  })

  // Disabling the connector is the blunt instrument — one switch, every tool.
  test('disabling the connector withdraws all of its tools', async () => {
    await setConnectorEnabled(db, { connectorId: 'linear', enabled: false })
    expect(await listEnabledConnectorTools(db)).toEqual([])
  })

  test('resolves one tool with its connector by id', async () => {
    const found = await getConnectorTool(db, 'mcp:linear:a')
    expect(found?.tool.toolName).toBe('a')
    expect(found?.connector.url).toBe('https://mcp.linear.app/mcp')
    expect(await getConnectorTool(db, 'mcp:linear:nope')).toBeNull()
  })
})

describe('connections', () => {
  test('stores and reads back a credential', async () => {
    await saveConnection(db, {
      connectorId: 'linear',
      accessToken: 'wfc1.aaa.bbb',
      refreshToken: 'wfc1.ccc.ddd',
      accountLabel: 'Steve @ Artisian',
      scopes: 'read',
    })
    const conn = await getConnection(db, 'linear')
    expect(conn?.accountLabel).toBe('Steve @ Artisian')
    expect(conn?.status).toBe('connected')
    // The storage layer only ever sees ciphertext.
    expect(isEncrypted(conn?.accessToken)).toBe(true)
  })

  // Reconnecting must REPLACE, never accumulate: two live credentials for one
  // connector would mean a run's behaviour depends on which row it read.
  test('reconnecting updates in place', async () => {
    await saveConnection(db, {
      connectorId: 'linear',
      accessToken: 'wfc1.aaa.first',
    })
    const first = await getConnection(db, 'linear')
    await saveConnection(db, {
      connectorId: 'linear',
      accessToken: 'wfc1.aaa.second',
    })
    const second = await getConnection(db, 'linear')
    expect(second?.id).toBe(first!.id)
    expect(second?.accessToken).toBe('wfc1.aaa.second')
    // A new lineage — any in-flight refresh holding the old version loses.
    expect(second!.tokenVersion).toBeGreaterThan(first!.tokenVersion)
  })

  test('a reconnect clears a previous failure', async () => {
    await saveConnection(db, {
      connectorId: 'linear',
      accessToken: 'wfc1.a.b',
    })
    const conn = await getConnection(db, 'linear')
    await updateConnectionTokens(db, {
      connectionId: conn!.id,
      expectedVersion: conn!.tokenVersion,
      accessToken: 'wfc1.a.c',
    })
    await saveConnection(db, {
      connectorId: 'linear',
      accessToken: 'wfc1.a.d',
    })
    const after = await getConnection(db, 'linear')
    expect(after?.status).toBe('connected')
    expect(after?.lastError).toBeNull()
  })
})

describe('token refresh concurrency', () => {
  // Two nodes in one run can both hit an expired token. Exactly one may spend
  // the single-use refresh token; the other has to notice it lost and re-read.
  test('only the first writer with the expected version wins', async () => {
    await saveConnection(db, {
      connectorId: 'linear',
      accessToken: 'wfc1.a.old',
      refreshToken: 'wfc1.r.old',
    })
    const conn = await getConnection(db, 'linear')
    const version = conn!.tokenVersion

    const first = await updateConnectionTokens(db, {
      connectionId: conn!.id,
      expectedVersion: version,
      accessToken: 'wfc1.a.new',
      refreshToken: 'wfc1.r.new',
    })
    const second = await updateConnectionTokens(db, {
      connectionId: conn!.id,
      expectedVersion: version,
      accessToken: 'wfc1.a.loser',
    })

    expect(first).toBe(true)
    expect(second).toBe(false)
    const after = await getConnection(db, 'linear')
    expect(after?.accessToken).toBe('wfc1.a.new')
    expect(after?.tokenVersion).toBe(version + 1)
  })
})

describe('oauth state', () => {
  const attempt = (state: string, expiresInMs = 60_000) => ({
    state,
    connectorId: 'linear',
    codeVerifier: 'wfc1.v.v',
    redirectUri: 'https://app.test/api/wf/connectors/callback',
    tokenEndpoint: 'https://mcp.linear.app/token',
    expiresAt: new Date(Date.now() + expiresInMs),
  })

  // Single-use is the security property: a replayed callback must find nothing.
  test('is consumed exactly once', async () => {
    await createOauthState(db, attempt('state-1'))
    expect((await consumeOauthState(db, 'state-1'))?.connectorId).toBe('linear')
    expect(await consumeOauthState(db, 'state-1')).toBeNull()
  })

  test('an expired attempt is rejected and cleared', async () => {
    await createOauthState(db, attempt('state-2', -1000))
    expect(await consumeOauthState(db, 'state-2')).toBeNull()
    // Cleared even though it was rejected, so it cannot be retried.
    expect(await consumeOauthState(db, 'state-2')).toBeNull()
  })

  test('an unknown state is simply absent', async () => {
    expect(await consumeOauthState(db, 'never-issued')).toBeNull()
  })
})

describe('deleting a connector', () => {
  // A credential outliving its connector would be a live token nothing on the
  // page accounts for.
  test('takes its tools, credential, client and attempts with it', async () => {
    await upsertConnectorTools(db, 'linear', [tool('a')])
    await saveConnection(db, {
      connectorId: 'linear',
      accessToken: 'wfc1.a.b',
    })
    await saveConnectorClient(db, {
      connectorId: 'linear',
      clientId: 'client-123',
      redirectUri: 'https://app.test/cb',
    })
    await createOauthState(db, {
      state: 'state-x',
      connectorId: 'linear',
      codeVerifier: 'wfc1.v.v',
      redirectUri: 'https://app.test/cb',
      tokenEndpoint: 'https://mcp.linear.app/token',
      expiresAt: new Date(Date.now() + 60_000),
    })

    await deleteConnector(db, 'linear')

    expect(await listConnectorTools(db, 'linear')).toEqual([])
    expect(await getConnection(db, 'linear')).toBeNull()
    expect(await consumeOauthState(db, 'state-x')).toBeNull()
    expect(await listEnabledConnectorTools(db)).toEqual([])
  })
})
