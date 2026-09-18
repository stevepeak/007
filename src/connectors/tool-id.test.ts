import { describe, expect, test } from 'bun:test'

import {
  connectorToolId,
  isConnectorToolId,
  CONNECTOR_ID_PATTERN,
  parseConnectorToolId,
  schemaHash,
  slugifyConnectorId,
} from './tool-id'

describe('connector tool ids', () => {
  test('round-trips', () => {
    const id = connectorToolId('linear', 'create_issue')
    expect(id).toBe('mcp:linear:create_issue')
    expect(parseConnectorToolId(id)).toEqual({
      connectorId: 'linear',
      toolName: 'create_issue',
    })
  })

  // Host tools must fall through to the static registry untouched.
  test('does not claim host tool ids', () => {
    for (const id of ['search_knowledge_base', 'create_document', 'mcp', 'mcpx:a:b']) {
      expect(isConnectorToolId(id)).toBe(false)
      expect(parseConnectorToolId(id)).toBeNull()
    }
  })

  // Tool names are the server's to choose and the spec doesn't forbid a colon;
  // only the first two segments are ours.
  test('keeps a colon inside the tool name', () => {
    expect(parseConnectorToolId('mcp:linear:issues:create')).toEqual({
      connectorId: 'linear',
      toolName: 'issues:create',
    })
  })

  test('rejects malformed ids rather than guessing', () => {
    for (const id of ['mcp:', 'mcp:linear', 'mcp::create', 'mcp:linear:']) {
      expect(parseConnectorToolId(id)).toBeNull()
    }
  })
})

describe('schema hashing', () => {
  // Key order is not a change. A server that serialises non-deterministically
  // would otherwise report drift on every refresh, making the signal worthless.
  test('is insensitive to key order at any depth', async () => {
    const a = await schemaHash({
      inputSchema: {
        type: 'object',
        properties: { b: { type: 'string' }, a: { type: 'number' } },
      },
    })
    const b = await schemaHash({
      inputSchema: {
        properties: { a: { type: 'number' }, b: { type: 'string' } },
        type: 'object',
      },
    })
    expect(a).toBe(b)
  })

  test('changes when the shape actually changes', async () => {
    const before = await schemaHash({
      inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
    })
    const after = await schemaHash({
      inputSchema: { type: 'object', properties: { a: { type: 'number' } } },
    })
    expect(before).not.toBe(after)
  })

  // Output schema is part of the contract a Tool node's downstream binding
  // reads, so a change there has to register as drift too.
  test('covers the output schema', async () => {
    const withOut = await schemaHash({
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    })
    const without = await schemaHash({ inputSchema: { type: 'object' } })
    expect(withOut).not.toBe(without)
  })

  test('array order is significant', async () => {
    const a = await schemaHash({ inputSchema: { required: ['a', 'b'] } })
    const b = await schemaHash({ inputSchema: { required: ['b', 'a'] } })
    expect(a).not.toBe(b)
  })
})

describe('slugifyConnectorId', () => {
  test('slugs a label the way the old form did', () => {
    expect(slugifyConnectorId('Linear')).toBe('linear')
    expect(slugifyConnectorId('  GitHub (prod) ')).toBe('github-prod')
    expect(slugifyConnectorId('Acme_CRM v2')).toBe('acme-crm-v2')
  })

  test('always satisfies CONNECTOR_ID_PATTERN', () => {
    for (const label of ['🚀', '---', '', 'x'.repeat(200), 'A'.repeat(62) + '-']) {
      expect(slugifyConnectorId(label)).toMatch(CONNECTOR_ID_PATTERN)
    }
  })
})
