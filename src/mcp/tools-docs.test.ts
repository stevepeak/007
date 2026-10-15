import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, test } from 'bun:test'

import type { WfDataClient } from '../server/protocol'

import { allTools } from './catalog'
import { docTopics } from './docs/registry'
import { createWfMcpServer } from './server'
import { WF_MCP_INSTRUCTIONS } from './tools-docs'

// `get_docs` over a real MCP session: the three modes, the forgiving topic
// lookup, and the two ways a client meets the docs without asking — the
// server's `instructions` and its resource list.

async function connect(write = false): Promise<Client> {
  const server = createWfMcpServer({ client: {} as WfDataClient, write })
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])
  return client
}

async function getDocs(
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const client = await connect()
  const result = (await client.callTool({ name: 'get_docs', arguments: args })) as {
    content: { text: string }[]
    isError?: boolean
  }
  return { text: result.content[0]?.text ?? '', isError: result.isError === true }
}

describe('get_docs', () => {
  test('is a read tool, listed first', () => {
    const [first] = allTools()
    expect(first?.name).toBe('get_docs')
    expect(first?.readOnly).toBe(true)
  })

  test('no arguments → the overview, as Markdown rather than JSON', async () => {
    const { text, isError } = await getDocs({})
    expect(isError).toBe(false)
    expect(text.startsWith('# ')).toBe(true)
    expect(text).toContain('`aggregate`')
    expect(text).toContain('`get_run`')
    // The topic index is live — every page is reachable from the overview.
    for (const t of docTopics()) expect(text).toContain(`\`${t.id}\``)
  })

  test('a bare node kind finds its page', async () => {
    const { text, isError } = await getDocs({ topic: 'race' })
    expect(isError).toBe(false)
    expect(text).toContain('# ')
    expect(text.toLowerCase()).toContain('race')
  })

  test('an unknown topic says what exists', async () => {
    const { text, isError } = await getDocs({ topic: 'joins-and-stuff' })
    expect(isError).toBe(true)
    expect(text).toContain('All topics:')
    expect(text).toContain('execution')
  })

  test('query returns the sections that name a config key', async () => {
    const { text } = await getDocs({ query: 'fastTrack' })
    expect(text).toContain('# Search: fastTrack')
    expect(text).toContain('fastTrack')
    expect(text).toContain('_From `')
  })

  test('a query nothing matches points back at the index', async () => {
    const { text } = await getDocs({ query: 'zzqqxx' })
    expect(text).toContain('Nothing matched')
  })
})

describe('meeting the docs without asking', () => {
  test('the server instructions point at get_docs', async () => {
    const client = await connect()
    expect(client.getInstructions()).toBe(WF_MCP_INSTRUCTIONS)
    expect(WF_MCP_INSTRUCTIONS).toContain('get_docs')
  })

  test('every topic is also a resource', async () => {
    const client = await connect()
    const { resources } = await client.listResources()
    expect(resources.map((r) => r.uri).sort()).toEqual(
      docTopics()
        .map((t) => `wf-docs://${t.id}`)
        .sort(),
    )
    const read = await client.readResource({ uri: 'wf-docs://execution' })
    const first = read.contents[0] as { text?: string; mimeType?: string }
    expect(first.mimeType).toBe('text/markdown')
    expect(first.text).toContain('fastTrack')
  })
})
