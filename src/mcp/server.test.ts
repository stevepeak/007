import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, test } from 'bun:test'

import type { WfDataClient } from '../server/protocol'

import { createWfMcpServer } from './server'
import type { WfMcpTool } from './tools'

/**
 * End-to-end over a real MCP session (in-memory transport, real client), which
 * is the only way to check the things that only exist once the protocol is
 * involved: what `tools/list` actually advertises, and what a failing handler
 * looks like from the other side.
 */

const listAgents: WfMcpTool = {
  name: 'list_agents',
  title: 'List agents',
  description: 'read',
  inputSchema: {},
  readOnly: true,
  run: async () => [{ id: 'agent_1', name: 'Intake' }],
}

const publishAgent: WfMcpTool = {
  name: 'publish_agent',
  title: 'Publish agent',
  description: 'write',
  inputSchema: {},
  readOnly: false,
  run: async () => ({ ok: true }),
}

async function connect(opts: {
  write?: boolean
  tools: WfMcpTool[]
}): Promise<Client> {
  const server = createWfMcpServer({
    client: {} as WfDataClient,
    write: opts.write,
    tools: opts.tools,
  })
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])
  return client
}

describe('the write gate', () => {
  // The gate is REGISTRATION, not a refusal inside a handler. A read-only
  // session must not even advertise a mutating tool, or the model can be
  // talked into reaching for one.
  test('a read-only server does not advertise write tools', async () => {
    const client = await connect({ tools: [listAgents, publishAgent] })
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['list_agents'])
  })

  test('a write-enabled server advertises both', async () => {
    const client = await connect({
      write: true,
      tools: [listAgents, publishAgent],
    })
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'list_agents',
      'publish_agent',
    ])
  })

  test('calling an unregistered write tool fails as unknown', async () => {
    const client = await connect({ tools: [listAgents, publishAgent] })
    const result = (await client.callTool({
      name: 'publish_agent',
      arguments: {},
    })) as { isError?: boolean; content: { text: string }[] }
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toMatch(/not found|unknown/i)
  })
})

describe('tool results', () => {
  test('come back as one JSON text block', async () => {
    const client = await connect({ tools: [listAgents] })
    const result = (await client.callTool({
      name: 'list_agents',
      arguments: {},
    })) as { content: { type: string; text: string }[] }
    expect(result.content[0]?.type).toBe('text')
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual([
      { id: 'agent_1', name: 'Intake' },
    ])
  })

  // A 403 from a stale token is the failure a user will actually hit. It has
  // nothing to do with the arguments, so the model has to be able to read it.
  test('a failing call is content the model can read, not a transport error', async () => {
    const client = await connect({
      tools: [
        {
          ...listAgents,
          run: async () => {
            throw new Error('Invalid service token')
          },
        },
      ],
    })
    const result = (await client.callTool({
      name: 'list_agents',
      arguments: {},
    })) as { isError?: boolean; content: { text: string }[] }
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('Invalid service token')
  })
})
