import { describe, expect, test } from 'bun:test'

import type { WfSdkConfig } from '../engine/config'
import type { ToolRegistry, ToolRegistryEntry } from '../engine/tool-registry'

import {
  connectorToolEntries,
  withConnectorTools,
  type ConnectorCatalogEntry,
  type ConnectorRuntime,
} from './registry'

type Deps = { marker: string }

function catalogEntry(
  over: Partial<ConnectorCatalogEntry> = {},
): ConnectorCatalogEntry {
  return {
    id: 'mcp:linear:create_issue',
    connectorId: 'linear',
    connectorLabel: 'Linear',
    connectorUrl: 'https://mcp.linear.app/mcp',
    transport: 'http',
    toolName: 'create_issue',
    title: 'Create issue',
    description: 'Creates an issue in Linear.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, teamId: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    },
    outputSchema: null,
    sideEffect: 'write',
    schemaHash: 'hash-1',
    icon: null,
    iconName: null,
    color: null,
    ...over,
  }
}

// Reaching the database means argument validation let the call through.
const REACHED_DB = 'reached the database'
const runtime: ConnectorRuntime = {
  resolveDb: () => {
    throw new Error(REACHED_DB)
  },
  resolveSecret: () => 'key',
}

function hostEntry(id: string): ToolRegistryEntry<Deps> {
  return {
    id,
    name: 'A host tool',
    description: 'host',
    kind: 'function',
    build: () => () => Promise.resolve('host'),
  }
}

function configWith(registry: ToolRegistry<Deps>): WfSdkConfig<Deps> {
  return { toolRegistry: registry } as unknown as WfSdkConfig<Deps>
}

describe('catalog entries become registry entries', () => {
  test('carries the metadata the pickers and the engine read', () => {
    const [entry] = connectorToolEntries<Deps>([catalogEntry()], runtime)
    expect(entry.id).toBe('mcp:linear:create_issue')
    // The connector's name leads, so generic verbs still say whose they are.
    expect(entry.name).toBe('Linear: Create issue')
    expect(entry.description).toBe('Creates an issue in Linear.')
    expect(entry.sideEffect).toBe('write')
    // Neither side authored it, but a deployment cannot fix it by editing the
    // host repo — which is what `origin` is actually telling the reader.
    expect(entry.origin).toBe('sdk')
  })

  // `ai-tool` works in BOTH an agent's tool set and a Tool node; `function`
  // would be usable only as a Tool node.
  test('registers as an ai-tool so both call sites work', () => {
    const [entry] = connectorToolEntries<Deps>([catalogEntry()], runtime)
    expect(entry.kind).toBe('ai-tool')
  })

  test('falls back to the tool name when the server sent no title', () => {
    const [entry] = connectorToolEntries<Deps>(
      [catalogEntry({ title: null, description: null })],
      runtime,
    )
    expect(entry.name).toBe('Linear: create_issue')
    expect(entry.description).toContain('create_issue')
  })
})

describe('argument validation', () => {
  const execute = (entry: ToolRegistryEntry<Deps>) => {
    const built = entry.build({ marker: 'x' }) as {
      execute: (args: unknown, opts: unknown) => Promise<unknown>
    }
    return (args: Record<string, unknown>) =>
      built.execute(args, { toolCallId: 't', messages: [] })
  }

  // The drift guard. A published Tool node's bound args can stop matching the
  // server's schema without anyone touching the graph; the message has to name
  // the field rather than surfacing an opaque remote error.
  test('rejects args that do not match the server schema', async () => {
    const [entry] = connectorToolEntries<Deps>([catalogEntry()], runtime)
    await expect(execute(entry)({ teamId: 'TEAM' })).rejects.toThrow(
      /do not match what Linear expects/,
    )
    await expect(execute(entry)({ teamId: 'TEAM' })).rejects.toThrow(
      /schema may have changed/,
    )
  })

  test('rejects a wrongly-typed field', async () => {
    const [entry] = connectorToolEntries<Deps>([catalogEntry()], runtime)
    await expect(execute(entry)({ title: 42 })).rejects.toThrow(
      /do not match what Linear expects/,
    )
  })

  // Validation must not be so eager that it blocks a legitimate call: valid
  // args get as far as resolving the credential.
  test('lets valid args through to the credential lookup', async () => {
    const [entry] = connectorToolEntries<Deps>([catalogEntry()], runtime)
    await expect(execute(entry)({ title: 'Ship it' })).rejects.toThrow(
      REACHED_DB,
    )
  })

  // A server that declares no input schema is not a reason to refuse a call.
  test('passes through when the server declared no schema', async () => {
    const [entry] = connectorToolEntries<Deps>(
      [catalogEntry({ inputSchema: null })],
      runtime,
    )
    await expect(execute(entry)({ anything: true })).rejects.toThrow(REACHED_DB)
  })
})

describe('merging into the host registry', () => {
  test('adds connector tools alongside host tools', () => {
    const host: ToolRegistry<Deps> = new Map([
      ['tavily_search', hostEntry('tavily_search')],
    ])
    const merged = withConnectorTools(
      configWith(host),
      [catalogEntry()],
      runtime,
    )
    expect([...merged.toolRegistry.keys()].sort()).toEqual([
      'mcp:linear:create_issue',
      'tavily_search',
    ])
  })

  // The host's registry is module-scope state shared by every run in the
  // isolate. Mutating it would leak one run's catalog snapshot into the next.
  test('never mutates the host registry', () => {
    const host: ToolRegistry<Deps> = new Map([
      ['tavily_search', hostEntry('tavily_search')],
    ])
    withConnectorTools(configWith(host), [catalogEntry()], runtime)
    expect([...host.keys()]).toEqual(['tavily_search'])
  })

  // Namespacing is supposed to make this impossible; if a host does it anyway,
  // the tool they wrote and can debug is the safer one to keep.
  test('a host tool wins an id collision', () => {
    const host: ToolRegistry<Deps> = new Map([
      ['mcp:linear:create_issue', hostEntry('mcp:linear:create_issue')],
    ])
    const merged = withConnectorTools(
      configWith(host),
      [catalogEntry()],
      runtime,
    )
    expect(merged.toolRegistry.get('mcp:linear:create_issue')?.name).toBe(
      'A host tool',
    )
  })

  test('an empty catalog returns the config untouched', () => {
    const config = configWith(new Map())
    expect(withConnectorTools(config, [], runtime)).toBe(config)
  })
})
