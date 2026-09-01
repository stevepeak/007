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

describe('get_dashboard', () => {
  /** A dashboard payload with the chart arrays that dominate its size. */
  function dashboard(over: Record<string, unknown> = {}): never {
    const points = Array.from({ length: 24 }, (_, i) => i)
    return {
      // A fixed 24h window whatever it is handed — the clamp, in stub form.
      since: 1_000_000,
      until: 1_000_000 + 24 * 3_600_000,
      bucket: 'hour',
      buckets: points,
      runs: {
        total: 200,
        failed: 20,
        inFlight: 3,
        series: [
          { key: 'w1', label: 'Intake', total: 150, points },
          { key: 'w2', label: 'Conflicts', total: 50, points },
        ],
        failedPoints: points,
        source: 'db',
      },
      cost: {
        totalUsd: 12.5,
        totalTokens: 900_000,
        unpricedTokens: 1000,
        series: [{ key: 'venice:x', label: 'Qwen', total: 12.5, points }],
        source: 'db',
        pricedAtRunTime: false,
      },
      feedback: {
        unacknowledged: 4,
        unacknowledgedDown: 2,
        up: 9,
        down: 2,
        upPoints: points,
        downPoints: points,
      },
      steps: null,
      recentFailures: [],
      ...over,
    } as never
  }

  function run(over: Record<string, unknown> = {}, args: Record<string, unknown> = {}) {
    const client = stubClient({ getDashboard: async () => dashboard(over) })
    return toolNamed('get_dashboard').run(client, args) as Promise<
      Record<string, never>
    >
  }

  // The whole reason for the projection: the payload is mostly one number per
  // bucket per series, on four panels, because it draws charts. Nothing here
  // draws anything, and a 90-day window would spend thousands of tokens on
  // arrays that can only be summed back into a total that is already present.
  test('leaves the per-bucket chart arrays out', async () => {
    const json = JSON.stringify(await run())
    expect(json).not.toContain('points')
    expect(json).not.toContain('buckets')
    expect(json).toContain('Intake')
  })

  // A failure count reads very differently against 20 runs than against 2000,
  // and dividing is exactly the step a reader skips.
  test('states the failure rate rather than leaving it to be divided', async () => {
    const result = (await run()) as unknown as {
      runs: { failureRate: number; inFlight: number }
    }
    expect(result.runs.failureRate).toBe(0.1)
    expect(result.runs.inFlight).toBe(3)
  })

  test('reports no rate at all when nothing ran', async () => {
    const result = (await run({
      runs: {
        total: 0,
        failed: 0,
        inFlight: 0,
        series: [],
        failedPoints: [],
        source: 'db',
      },
    })) as unknown as { runs: { failureRate: number | null } }
    // Not 0 — "nothing failed" and "nothing ran" are different answers.
    expect(result.runs.failureRate).toBeNull()
  })

  // The window is derived from a friendly `hours`, because a model has no
  // reliable clock and epoch-millis arguments invite an invented one.
  test('turns hours into a window and picks the bucket itself', async () => {
    const seen: Record<string, unknown>[] = []
    const client = stubClient({
      getDashboard: async (input) => {
        seen.push(input)
        return dashboard()
      },
    })
    const tool = toolNamed('get_dashboard')
    await tool.run(client, { hours: 12 })
    await tool.run(client, { hours: 24 * 30 })
    expect(seen[0]?.bucket).toBe('hour')
    expect(seen[1]?.bucket).toBe('day')
    const first = seen[0] as { since: number; until: number }
    expect(Math.round((first.until - first.since) / 3_600_000)).toBe(12)
  })

  // The server clamps what it is asked for, so the window it CHARTED is the one
  // worth reporting — a reader comparing two calls needs to know which it got.
  test('reports the window the server answered with, not the one asked for', async () => {
    const result = (await run({}, { hours: 999_999 })) as unknown as {
      window: { hours: number }
    }
    // Asked for 114 years; the stub clamped to a day, and that is what is said.
    expect(result.window.hours).toBe(24)
  })

  // Null, never zero: nothing in SQL counts `step.do` calls, and a fabricated 0
  // would read as "these runs were free".
  test('keeps unconfigured step billing null rather than zero', async () => {
    const result = (await run()) as unknown as { steps: unknown }
    expect(result.steps).toBeNull()
  })

  test('carries each failure’s error text, clipped', async () => {
    const result = (await run({
      recentFailures: [
        {
          id: 'run_1',
          workflowName: 'Intake',
          triggerKind: 'chat',
          finishedAt: 5,
          error: 'x'.repeat(5000),
        },
      ],
    })) as unknown as {
      recentFailures: { runId: string; error: string }[]
    }
    expect(result.recentFailures[0]?.runId).toBe('run_1')
    expect(result.recentFailures[0]?.error.length).toBeLessThan(600)
  })
})
