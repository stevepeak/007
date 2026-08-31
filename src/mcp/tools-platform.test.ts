import { describe, expect, test } from 'bun:test'

import type { WfDataClient } from '../server/protocol'

import { platformReadTools } from './tools-platform'
import type { WfMcpTool } from './tools'

function toolNamed(name: string): WfMcpTool {
  const found = platformReadTools().find((t) => t.name === name)
  if (!found) throw new Error(`no such tool: ${name}`)
  return found
}

function stubClient(partial: Partial<WfDataClient>): WfDataClient {
  return partial as WfDataClient
}

describe('list_models', () => {
  const models = [
    {
      id: 'venice:deepseek-v4-flash-0731',
      label: 'DeepSeek V4 Flash',
      providerId: 'venice',
      costPerMTok: 0.4,
      contextLength: 131_072,
    },
  ]

  // The reason this tool exists: `run_eval` takes model ids and nothing told
  // the model which ones are real. A composite id that loses its prefix 404s at
  // the provider, after the sweep has already been launched.
  test('hands back the composite id the rest of the API expects', async () => {
    const client = stubClient({
      listModels: async () => models,
      listProviders: async () => [{ id: 'venice', label: 'Venice' }] as never,
    })
    const result = (await toolNamed('list_models').run(client, {})) as {
      models: { id: string }[]
      providers: unknown[]
    }
    expect(result.models[0]?.id).toBe('venice:deepseek-v4-flash-0731')
    expect(result.providers).toHaveLength(1)
  })

  // "No models" and "no provider wired up" are different problems, but a
  // provider lookup failing should not cost the model the list it asked for.
  test('still answers when the provider lookup fails', async () => {
    const client = stubClient({
      listModels: async () => models,
      listProviders: () => Promise.reject(new Error('no provider configured')),
    })
    const result = (await toolNamed('list_models').run(client, {})) as {
      models: unknown[]
      providers: unknown[]
    }
    expect(result.models).toHaveLength(1)
    expect(result.providers).toEqual([])
  })
})

describe('list_changes', () => {
  function client(capture: { input?: unknown }, rows: unknown[] = []) {
    return stubClient({
      listChanges: async (input) => {
        capture.input = input
        return rows as never
      },
    })
  }

  test('clamps a model-supplied limit instead of trusting it', async () => {
    const seen: { input?: unknown } = {}
    await toolNamed('list_changes').run(client(seen), { limit: 9000 })
    expect((seen.input as { limit: number }).limit).toBe(100)

    await toolNamed('list_changes').run(client(seen), {})
    expect((seen.input as { limit: number }).limit).toBe(30)
  })

  // `.nullish()` means an omitted filter arrives as null, and a null forwarded
  // as a filter value would match nothing.
  test('drops null filters rather than forwarding them', async () => {
    const seen: { input?: unknown } = {}
    await toolNamed('list_changes').run(client(seen), {
      entityKind: null,
      actorId: null,
    })
    const input = seen.input as { entityKind?: string; actorId?: string }
    expect(input.entityKind).toBeUndefined()
    expect(input.actorId).toBeUndefined()
  })

  // A publish carries the whole agent config or workflow graph in `after`.
  test('bounds a payload that carries a whole entity', async () => {
    const seen: { input?: unknown } = {}
    const rows = [
      {
        id: 'chg_1',
        entityKind: 'agent',
        action: 'publish',
        before: null,
        after: { prompt: 'x'.repeat(40_000) },
      },
    ]
    const result = (await toolNamed('list_changes').run(
      client(seen, rows),
      {},
    )) as { after: unknown; action: string }[]
    expect(String(result[0]?.after)).toContain('truncated')
    // The row's own fields survive — it is the payload that is bounded.
    expect(result[0]?.action).toBe('publish')
  })
})
