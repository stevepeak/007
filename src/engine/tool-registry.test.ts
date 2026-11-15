import { describe, expect, test } from 'bun:test'

import { resolveAgentToolIds, simulatedToolOutput } from './tool-registry'

// The one place a tool's eval behavior is decided, shared by both dispatch paths
// (an Agent node's tool set and a Tool node) so neutering can't diverge between
// them. `undefined` here means "execute for real" — which is why every branch is
// worth a test: getting one wrong doesn't fail loudly, it quietly runs a tool
// against real data in a test that was supposed to be reproducible.

const read = { id: 'search_rag', sideEffect: 'read' } as const
const write = { id: 'escalate_chat', sideEffect: 'write' } as const

describe('simulatedToolOutput', () => {
  test('outside simulate, everything executes', () => {
    expect(simulatedToolOutput(read, { simulate: false })).toBeUndefined()
    expect(simulatedToolOutput(write, undefined)).toBeUndefined()
  })

  test('a write tool is neutralized whatever the modes say', () => {
    // An eval never writes — not for a `live` entry, not for a live default.
    expect(
      simulatedToolOutput(write, {
        simulate: true,
        liveReads: true,
        toolModes: { escalate_chat: 'live' },
      }),
    ).toEqual({ output: { simulated: true } })
  })

  test('a tool that declares no side effect is never intercepted', () => {
    expect(
      simulatedToolOutput({ id: 'whatever' }, { simulate: true, fixtures: {} }),
    ).toBeUndefined()
  })

  test('a mocked read tool returns its fixture, or an empty result', () => {
    const ctx = { simulate: true, fixtures: { search_rag: { hits: 2 } } }
    expect(simulatedToolOutput(read, ctx)).toEqual({ output: { hits: 2 } })
    expect(simulatedToolOutput(read, { simulate: true })).toEqual({ output: {} })
  })

  test('a per-tool `live` entry executes while its neighbours stay mocked', () => {
    // The whole point of per-tool settings: this is unrepresentable with one
    // run-wide flag.
    const ctx = {
      simulate: true,
      fixtures: { memory: { items: [] } },
      toolModes: { search_rag: 'live', memory: 'mocked' } as const,
    }
    expect(simulatedToolOutput(read, ctx)).toBeUndefined()
    expect(
      simulatedToolOutput({ id: 'memory', sideEffect: 'read' }, ctx),
    ).toEqual({ output: { items: [] } })
  })

  test('a per-tool `mocked` entry overrides a live default', () => {
    // How a row migrated from the old sample-wide Live mode gets pinned one
    // tool at a time: the entry wins, the fallback covers the rest.
    const ctx = {
      simulate: true,
      liveReads: true,
      fixtures: { search_rag: { hits: 1 } },
      toolModes: { search_rag: 'mocked' } as const,
    }
    expect(simulatedToolOutput(read, ctx)).toEqual({ output: { hits: 1 } })
    expect(
      simulatedToolOutput({ id: 'other', sideEffect: 'read' }, ctx),
    ).toBeUndefined()
  })
})

const KNOWN = ['lookup', 'mcp:acme:a', 'mcp:acme:b', 'mcp:other:c']

describe('resolveAgentToolIds', () => {
  test('a whole connector expands to its tools only', () => {
    const r = resolveAgentToolIds({
      toolIds: ['lookup', 'mcp:acme:*'],
      deferredToolIds: [],
      knownIds: KNOWN,
    })
    expect(r.ids).toEqual(['lookup', 'mcp:acme:a', 'mcp:acme:b'])
    expect([...r.deferred]).toEqual([])
  })

  test('a deferred connector defers each of its tools', () => {
    const r = resolveAgentToolIds({
      toolIds: ['lookup', 'mcp:acme:*'],
      deferredToolIds: ['mcp:acme:*'],
      knownIds: KNOWN,
    })
    expect([...r.deferred]).toEqual(['mcp:acme:a', 'mcp:acme:b'])
  })

  // "All of Acme, searchable, but `b` in context" is two entries.
  test('a tool listed on its own wins over the connector covering it', () => {
    const r = resolveAgentToolIds({
      toolIds: ['mcp:acme:*', 'mcp:acme:b'],
      deferredToolIds: ['mcp:acme:*'],
      knownIds: KNOWN,
    })
    expect(r.ids).toEqual(['mcp:acme:a', 'mcp:acme:b'])
    expect([...r.deferred]).toEqual(['mcp:acme:a'])
  })

  test('a disabled tool is skipped, the rest of the connector kept', () => {
    const r = resolveAgentToolIds({
      toolIds: ['mcp:acme:*'],
      deferredToolIds: [],
      disabledToolIds: ['mcp:acme:a'],
      knownIds: KNOWN,
    })
    expect(r.ids).toEqual(['mcp:acme:b'])
  })

  test('an unknown connector expands to nothing', () => {
    const r = resolveAgentToolIds({
      toolIds: ['mcp:gone:*'],
      deferredToolIds: [],
      knownIds: KNOWN,
    })
    expect(r.ids).toEqual([])
  })

  test('a host group expands like a connector, and stays apart from it', () => {
    const r = resolveAgentToolIds({
      toolIds: ['app:*', 'mcp:acme:*'],
      deferredToolIds: ['app:*'],
      disabledToolIds: ['app:delete'],
      knownIds: [...KNOWN, 'app:list', 'app:delete', 'apple'],
    })
    expect(r.ids).toEqual(['app:list', 'mcp:acme:a', 'mcp:acme:b'])
    expect([...r.deferred]).toEqual(['app:list'])
  })
})
