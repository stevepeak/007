import { describe, expect, test } from 'bun:test'

import type { WfDataClient } from '../server/protocol'

import type { WfMcpTool } from './tools'
import { connectorReadTools, connectorWriteTools } from './tools-connectors'

/**
 * What these pin is the one question the console could answer and this surface
 * could not: whether a connector tool is MISSING or WITHDRAWN.
 *
 * The catalog stops listing a connector tool when its connector is disabled or
 * its credential expires, so "the Linear tools vanished" and "the Linear token
 * expired" produce an identical observation — and only the second is actionable.
 * Every assertion below is about that distinction surviving the projection.
 */

function toolNamed(name: string): WfMcpTool {
  const found = [...connectorReadTools(), ...connectorWriteTools()].find(
    (t) => t.name === name,
  )
  if (!found) throw new Error(`no such tool: ${name}`)
  return found
}

function stubClient(partial: Partial<WfDataClient>): WfDataClient {
  return partial as WfDataClient
}

const HOUR = 3_600_000

function connector(over: Record<string, unknown> = {}): never {
  return {
    id: 'linear',
    label: 'Linear',
    url: 'https://mcp.linear.app/mcp',
    transport: 'http',
    authKind: 'oauth',
    enabled: true,
    note: null,
    lastRefreshedAt: 1_700_000_000_000,
    toolCount: 12,
    enabledToolCount: 3,
    connection: {
      status: 'connected',
      accountLabel: 'steve@…',
      scopes: 'read write',
      expiresAt: Date.now() + HOUR,
      error: null,
      connectedAt: 1_700_000_000_000,
      canRefresh: true,
    },
    ...over,
  } as never
}

describe('list_connectors — telling withdrawn from never-existed', () => {
  const run = (over: Record<string, unknown> = {}, args = {}) => { return toolNamed('list_connectors').run(
      stubClient({
        getConnectorCapability: async () => ({ credentialsConfigured: true }),
        listConnectors: async () => [connector(over)],
      }),
      args,
    ) as Promise<{
      credentialsConfigured?: boolean
      connectors: { health: Record<string, unknown> }[]
      note?: string
    }> }

  test('reports a healthy connector without inventing a diagnosis', async () => {
    const out = await run()
    expect(out.connectors[0]?.health).toMatchObject({
      status: 'connected',
      accountLabel: 'steve@…',
      canRefresh: true,
    })
    // Nothing is wrong, so nothing is claimed to be.
    expect(out.connectors[0]?.health.diagnosis).toBeUndefined()
  })

  // The headline symptom.
  test('explains that a disconnected connector is why its tools vanished', async () => {
    const out = await run({
      connection: {
        status: 'expired',
        accountLabel: 'steve@…',
        scopes: 'read',
        expiresAt: Date.now() - HOUR,
        error: 'token expired',
        connectedAt: 1,
        canRefresh: true,
      },
    })
    const health = out.connectors[0].health
    expect(health.expired).toBe(true)
    expect(String(health.diagnosis)).toContain('vanished')
    // It can refresh itself, which is the actionable half.
    expect(String(health.diagnosis)).toContain('refresh_connector')
  })

  test('says a person must sign in when there is no refresh token', async () => {
    const out = await run({
      connection: {
        status: 'error',
        accountLabel: null,
        scopes: null,
        expiresAt: null,
        error: 'invalid_grant',
        connectedAt: 1,
        canRefresh: false,
      },
    })
    expect(String(out.connectors[0]?.health.diagnosis)).toContain(
      'sign in again',
    )
  })

  // A setup state, not a failure — and it reads identically to a broken one
  // unless something says which it is.
  test('distinguishes never-connected from broken', async () => {
    const out = await run({ connection: null })
    expect(out.connectors[0]?.health.status).toBe('never-connected')
    expect(String(out.connectors[0]?.health.diagnosis)).toContain(
      'Nobody has connected this yet',
    )
  })

  // Connected, enabled at the credential level, and still withdrawn — the one
  // case where the connection block alone would mislead.
  test('catches a connected connector that is switched off', async () => {
    const out = await run({ enabled: false })
    expect(String(out.connectors[0]?.health.diagnosis)).toContain(
      'switched off at the platform level',
    )
  })

  // Without this, an empty list reads as neglect rather than as unconfigured.
  test('leads with the deployment having no encryption key at all', async () => {
    const out = (await toolNamed('list_connectors').run(
      stubClient({
        getConnectorCapability: async () => ({ credentialsConfigured: false }),
        listConnectors: async () => [],
      }),
      {},
    )) as { credentialsConfigured: boolean; note: string }
    expect(out.credentialsConfigured).toBe(false)
    expect(out.note).toContain('no connector encryption key')
  })
})

describe('list_connectors — the tool drill-in', () => {
  const detail = {
    connector: connector(),
    tools: [
      {
        id: 'mcp:linear:create_issue',
        toolName: 'create_issue',
        title: 'Create issue',
        description: 'Creates an issue.',
        inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
        outputSchema: { type: 'object' },
        enabled: true,
        sideEffect: 'write',
        sideEffectOverridden: false,
        missingSince: null,
        lastSeenAt: 1,
        schemaHash: 'h1',
      },
      {
        id: 'mcp:linear:archive_issue',
        toolName: 'archive_issue',
        title: null,
        description: 'Archives one.',
        inputSchema: undefined,
        outputSchema: undefined,
        enabled: false,
        sideEffect: 'write',
        sideEffectOverridden: false,
        missingSince: 1_700_000_000_000,
        lastSeenAt: 1,
        schemaHash: 'h2',
      },
    ],
  }

  const run = (args: Record<string, unknown>) => { return toolNamed('list_connectors').run(
      stubClient({ getConnector: async () => detail as never }),
      args,
    ) as Promise<{
      tools: Record<string, unknown>[]
      hiddenDisabledTools?: number
      note: string
    }> }

  // The CPU argument behind the host-side schema strip does not apply here —
  // MCP hands us JSON Schema already. Nobody had wired the call.
  test('carries each tool’s input schema', async () => {
    const out = await run({ connectorId: 'linear' })
    expect(out.tools[0]?.inputSchema).toEqual({
      type: 'object',
      properties: { title: { type: 'string' } },
    })
  })

  test('hides disabled tools by default and counts them', async () => {
    const out = await run({ connectorId: 'linear' })
    expect(out.tools).toHaveLength(1)
    expect(out.hiddenDisabledTools).toBe(1)
  })

  // A tool the server stopped advertising is still referenced by whatever bound
  // it, and will now fail.
  test('surfaces a tool the server no longer advertises', async () => {
    const out = await run({ connectorId: 'linear', includeDisabledTools: true })
    const gone = out.tools.find((t) => t.id === 'mcp:linear:archive_issue')
    expect(gone?.missingSince).toContain('2023')
  })

  test('says enabling a tool is not something to do from here', async () => {
    const out = await run({ connectorId: 'linear' })
    expect(out.note).toContain('person’s decision')
  })

  test('a missing connector names the id shape rather than throwing', async () => {
    const out = (await toolNamed('list_connectors').run(
      stubClient({ getConnector: async () => null as never }),
      { connectorId: 'nope' },
    )) as { error: string }
    expect(out.error).toContain('mcp:<slug>:<tool>')
  })
})

describe('list_tool_invocations', () => {
  const rows = [
    {
      runId: 'run_1',
      nodeId: 'n1',
      status: 'completed',
      args: { query: 'x'.repeat(10_000) },
      output: { hits: [] },
      error: null,
      startedAt: 1_000,
      finishedAt: 2_500,
      workflowId: 'w1',
      workflowName: 'Intake',
    },
    {
      runId: 'run_2',
      nodeId: 'n1',
      status: 'failed',
      args: {},
      output: null,
      error: 'upstream 500',
      startedAt: null,
      finishedAt: null,
      workflowId: 'w1',
      workflowName: 'Intake',
    },
  ]

  test('reports what the tool was really called with, and how often it failed', async () => {
    let seen: unknown
    const client = stubClient({
      listToolInvocations: async (input) => {
        seen = input
        return rows
      },
    })
    const out = (await toolNamed('list_tool_invocations').run(client, {
      toolId: 'search_rag',
    })) as {
      failed: number
      invocations: { durationMs: number | null; args: unknown }[]
    }
    expect(seen).toEqual({ toolId: 'search_rag', limit: 10 })
    expect(out.failed).toBe(1)
    expect(out.invocations[0]?.durationMs).toBe(1_500)
    // Real client data from production runs — read, not dumped.
    expect(JSON.stringify(out.invocations[0]?.args)).toContain('truncated')
  })

  // "Never called" and "called and broken" are different answers, and an empty
  // array alone reads as the second.
  test('says when nothing has ever called it', async () => {
    const client = stubClient({ listToolInvocations: async () => [] })
    const out = (await toolNamed('list_tool_invocations').run(client, {
      toolId: 'never_used',
    })) as { note: string }
    expect(out.note).toContain('never been called')
  })
})

describe('refresh_connector', () => {
  const base = { connector: connector(), tools: [] }

  function client(result: Record<string, unknown>, over: Partial<WfDataClient> = {}) {
    return stubClient({
      getConnector: async () => base,
      refreshConnector: async () => { return ({
          refreshedAt: 1_700_000_000_000,
          added: 0,
          updated: 0,
          missing: 0,
          drifted: [],
          toolCount: 12,
          ...result,
        }) },
      ...over,
    })
  }

  // The signal this tool exists for: a third party changed an argument under an
  // agent that still binds the old one — ART-146 arriving from outside the repo.
  test('leads with the drifted schemas and what to do about them', async () => {
    const out = (await toolNamed('refresh_connector').run(
      client({ drifted: ['mcp:linear:create_issue'], updated: 1 }),
      { connectorId: 'linear' },
    )) as { drifted: string[]; note: string }
    expect(out.drifted).toEqual(['mcp:linear:create_issue'])
    expect(out.note).toContain('validate_workflow_graph')
    expect(out.note).toContain('list_tool_invocations')
  })

  test('warns about tools the server has stopped advertising', async () => {
    const out = (await toolNamed('refresh_connector').run(
      client({ missing: 2 }),
      { connectorId: 'linear' },
    )) as { note: string }
    expect(out.note).toContain('fail at its next run')
  })

  // Grants no new trust — which is the whole reason this is the one connector
  // write that exists.
  test('says new tools arrive disabled when nothing changed', async () => {
    const out = (await toolNamed('refresh_connector').run(
      client({ added: 3 }),
      { connectorId: 'linear' },
    )) as { note: string; added: number }
    expect(out.added).toBe(3)
    expect(out.note).toContain('arrive DISABLED')
  })

  test('refuses an unknown id and names the real ones', async () => {
    let refreshed = false
    const out = (await toolNamed('refresh_connector').run(
      stubClient({
        getConnector: () => Promise.reject(new Error('not found')),
        listConnectors: async () => [connector()],
        refreshConnector: async () => {
          refreshed = true
          return {} as never
        },
      }),
      { connectorId: 'notion' },
    )) as { error: string; connectorIds: string[] }
    expect(out.error).toContain('No connector found')
    expect(out.connectorIds).toEqual(['linear'])
    expect(refreshed).toBe(false)
  })
})
