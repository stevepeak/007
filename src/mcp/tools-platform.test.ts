import { describe, expect, test } from 'bun:test'

import type { WfDataClient } from '../server/protocol'

import type { WfMcpTool } from './tools'
import { platformReadTools, platformWriteTools } from './tools-platform'

function toolNamed(name: string): WfMcpTool {
  const found = [...platformReadTools(), ...platformWriteTools()].find(
    (t) => t.name === name,
  )
  if (!found) throw new Error(`no such tool: ${name}`)
  return found
}

function stubClient(partial: Partial<WfDataClient>): WfDataClient {
  return partial as WfDataClient
}

/** A catalog with two enabled models, one disabled, and a usage edge. */
function catalog(over: Partial<Record<string, unknown>> = {}): never {
  return {
    providers: [
      {
        id: 'venice',
        label: 'Venice',
        kind: 'openai-compatible',
        enabled: true,
        lastRefreshedAt: 1_700_000_000_000,
        modelCount: 3,
        enabledCount: 2,
      },
    ],
    models: [
      {
        id: 'venice:deepseek-v4-flash-0731',
        modelId: 'deepseek-v4-flash-0731',
        label: 'DeepSeek V4 Flash',
        providerId: 'venice',
        vendor: 'deepseek',
        enabled: true,
        costPerMTok: 0.4,
        promptPricePerMTok: 0.2,
        completionPricePerMTok: 0.6,
        contextLength: 131_072,
        capabilities: { tools: true, structuredOutput: true },
      },
      {
        id: 'venice:big-thinker',
        modelId: 'big-thinker',
        label: 'Big Thinker',
        providerId: 'venice',
        vendor: 'anthropic',
        enabled: true,
        costPerMTok: 12,
        contextLength: 200_000,
        capabilities: { tools: true, reasoning: true },
      },
      {
        id: 'venice:off-on-purpose',
        modelId: 'off-on-purpose',
        label: 'Cheap But Off',
        providerId: 'venice',
        vendor: 'meta',
        enabled: false,
        costPerMTok: 0.05,
        contextLength: 8_000,
        // No `capabilities` AT ALL — the pre-refresh fallback shape. Distinct
        // from `{}`, which is a model KNOWN to support nothing; `unmetRequirements`
        // draws that same line, and the filter here has to draw it identically or
        // a model would be offered by one gate and refused by the other.
      },
    ],
    usage: {
      'venice:deepseek-v4-flash-0731': [
        { id: 'ag_1', name: 'Conflict check', icon: null, color: null },
      ],
    },
    ...over,
  } as never
}

describe('list_models', () => {
  const run = (args: Record<string, unknown> = {}, over = {}) => { return toolNamed('list_models').run(
      stubClient({ getModelCatalog: async () => catalog(over) }),
      args,
    ) }

  // The reason this tool exists: `run_eval` takes model ids and nothing told
  // the model which ones are real. A composite id that loses its prefix 404s at
  // the provider, after the sweep has already been launched.
  test('hands back the composite id the rest of the API expects', async () => {
    const result = (await run()) as {
      models: { id: string }[]
      providers: unknown[]
    }
    expect(result.models.some((m) => m.id === 'venice:deepseek-v4-flash-0731')).toBe(
      true,
    )
    expect(result.providers).toHaveLength(1)
  })

  // Enabled-only is the default because a disabled id is accepted nowhere.
  test('hides disabled models unless asked, and marks them when shown', async () => {
    const hidden = (await run()) as { models: { id: string }[] }
    expect(hidden.models.map((m) => m.id)).not.toContain('venice:off-on-purpose')

    const shown = (await run({ includeDisabled: true })) as {
      models: { id: string; enabled: boolean }[]
      counts: { enabledInCatalog: number; inCatalog: number }
    }
    // Labelled as disabled rather than hidden — which is what answers "is there
    // a cheaper model we already have but have not turned on?".
    const off = shown.models.find((m) => m.id === 'venice:off-on-purpose')
    expect(off?.enabled).toBe(false)
    expect(shown.counts).toMatchObject({ enabledInCatalog: 2, inCatalog: 3 })
  })

  test('sorts cheapest first so the alternative is the first row', async () => {
    const result = (await run({ includeDisabled: true })) as {
      models: { costPerMTok: number }[]
    }
    expect(result.models.map((m) => m.costPerMTok)).toEqual([0.05, 0.4, 12])
  })

  // Picking a model FOR a requirement, instead of guessing and being refused by
  // the agent-model gate.
  test('filters by capability, keeping models whose support is unreported', async () => {
    const reasoning = (await run({
      capability: 'reasoning',
      includeDisabled: true,
    })) as { models: { id: string }[] }
    // `off-on-purpose` reports no capabilities at all — unknown, never filtered
    // OUT. A model declaring `{}` would be, which is the gate's own rule.
    expect(reasoning.models.map((m) => m.id).sort()).toEqual([
      'venice:big-thinker',
      'venice:off-on-purpose',
    ])
  })

  test('filters by query, vendor, price ceiling and context floor', async () => {
    const byQuery = (await run({ query: 'THINK' })) as {
      models: { id: string }[]
    }
    expect(byQuery.models.map((m) => m.id)).toEqual(['venice:big-thinker'])

    const byVendor = (await run({ vendor: 'deepseek' })) as {
      models: { id: string }[]
    }
    expect(byVendor.models.map((m) => m.id)).toEqual([
      'venice:deepseek-v4-flash-0731',
    ])

    const cheap = (await run({ maxCostPerMTok: 1 })) as {
      models: { id: string }[]
    }
    expect(cheap.models.map((m) => m.id)).toEqual([
      'venice:deepseek-v4-flash-0731',
    ])

    const roomy = (await run({ minContextLength: 150_000 })) as {
      models: { id: string }[]
    }
    expect(roomy.models.map((m) => m.id)).toEqual(['venice:big-thinker'])
  })

  // The two facts that explain a surprising result — "only 2 of 3 are enabled"
  // and "last refreshed a while ago".
  test('carries each provider’s enabled count and refresh age', async () => {
    const result = (await run()) as {
      providers: {
        enabledCount: number
        modelCount: number
        lastRefreshedAt: string | null
      }[]
    }
    expect(result.providers[0]).toMatchObject({
      enabledCount: 2,
      modelCount: 3,
    })
    expect(result.providers[0]?.lastRefreshedAt).toContain('2023')
  })

  test('names the agents using a model — the blast radius before disabling it', async () => {
    const result = (await run()) as {
      models: { id: string; usedByAgents: string[] }[]
    }
    const used = result.models.find(
      (m) => m.id === 'venice:deepseek-v4-flash-0731',
    )
    expect(used?.usedByAgents).toEqual(['Conflict check'])
  })

  test('splits prompt and completion pricing, which the blend hides', async () => {
    const result = (await run({ query: 'deepseek' })) as {
      models: { promptPricePerMTok: number; completionPricePerMTok: number }[]
    }
    expect(result.models[0]?.promptPricePerMTok).toBe(0.2)
    expect(result.models[0]?.completionPricePerMTok).toBe(0.6)
  })

  // A filtered enabled list is still worth more than an error, so the catalog
  // read degrades to the plain one and SAYS it did.
  test('falls back to the plain enabled list when the catalog cannot be read', async () => {
    const client = stubClient({
      getModelCatalog: () => Promise.reject(new Error('catalog down')),
      listModels: async () => { return [{ id: 'venice:x', label: 'X', providerId: 'venice' }] as never },
      listProviders: async () => [{ id: 'venice', label: 'Venice' }] as never,
    })
    const result = (await toolNamed('list_models').run(client, {})) as {
      models: unknown[]
      degraded: string
    }
    expect(result.models).toHaveLength(1)
    expect(result.degraded).toContain('plain enabled list')
  })

  // "No models" and "no provider wired up" are different problems, but a
  // provider lookup failing should not cost the model the list it asked for.
  test('still answers when both the catalog and the provider lookup fail', async () => {
    const client = stubClient({
      getModelCatalog: () => Promise.reject(new Error('catalog down')),
      listModels: async () => [{ id: 'venice:x', label: 'X' }] as never,
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

describe('set_model_enabled', () => {
  test('withdraws a model workspace-wide and says so', async () => {
    let seen: unknown
    const client = stubClient({
      getModelCatalog: async () => catalog(),
      setModelEnabled: async (input) => {
        seen = input
        return { ok: true as const }
      },
    })
    const out = (await toolNamed('set_model_enabled').run(client, {
      modelId: 'venice:big-thinker',
      enabled: false,
    })) as { changed: boolean; note: string }
    expect(seen).toEqual({ modelId: 'venice:big-thinker', enabled: false })
    expect(out.changed).toBe(true)
    expect(out.note).toContain('workspace-wide')
  })

  // A wrong id would otherwise UPDATE zero rows and return ok — the silent
  // no-op that reads as success.
  test('refuses an id that is not in the catalog rather than no-opping', async () => {
    let wrote = false
    const client = stubClient({
      getModelCatalog: async () => catalog(),
      setModelEnabled: async () => {
        wrote = true
        return { ok: true as const }
      },
    })
    const out = (await toolNamed('set_model_enabled').run(client, {
      modelId: 'big-thinker',
      enabled: true,
    })) as { error: string }
    // The provider-native half of a composite id.
    expect(out.error).toContain('composite')
    expect(wrote).toBe(false)
  })

  test('writes nothing when the model is already in that state', async () => {
    let wrote = false
    const client = stubClient({
      getModelCatalog: async () => catalog(),
      setModelEnabled: async () => {
        wrote = true
        return { ok: true as const }
      },
    })
    const out = (await toolNamed('set_model_enabled').run(client, {
      modelId: 'venice:big-thinker',
      enabled: true,
    })) as { changed: boolean; note: string }
    expect(out.changed).toBe(false)
    // Nothing written means nothing in the change feed, which matters because
    // the feed is the only who-touched-this record.
    expect(out.note).toContain('nothing lands in the change feed')
    expect(wrote).toBe(false)
  })

  // The refusal names the agents, and those names are the actionable part.
  test('lets the in-use refusal through verbatim', async () => {
    const client = stubClient({
      getModelCatalog: async () => catalog(),
      setModelEnabled: async () => {
        throw new Error(
          "Can't disable this model — it's in use by 1 agent(s): Conflict check.",
        )
      },
    })
    await expect(
      toolNamed('set_model_enabled').run(client, {
        modelId: 'venice:deepseek-v4-flash-0731',
        enabled: false,
      }),
    ).rejects.toThrow('Conflict check')
  })

  test('refuses to guess when `enabled` is missing', async () => {
    await expect(
      toolNamed('set_model_enabled').run(stubClient({}), {
        modelId: 'venice:x',
      }),
    ).rejects.toThrow(/enabled/)
  })
})

describe('refresh_model_catalog', () => {
  test('reports the delta and that nothing was auto-enabled', async () => {
    let refreshed: unknown
    let call = 0
    const client = stubClient({
      getModelCatalog: async () => {
        call += 1
        // One new model appears on the second read — the refresh's effect.
        if (call === 1) return catalog()
        const next = catalog() as unknown as {
          models: Record<string, unknown>[]
        }
        next.models.push({
          id: 'venice:brand-new',
          providerId: 'venice',
          enabled: false,
          label: 'Brand New',
        })
        return next as never
      },
      refreshModels: async (input) => {
        refreshed = input
        return { count: 4, refreshedAt: 1_700_000_000_000 }
      },
    })
    const out = (await toolNamed('refresh_model_catalog').run(client, {
      providerId: 'venice',
    })) as {
      cached: number
      newlyDiscovered: number
      enabled: number
      note: string
    }
    expect(refreshed).toEqual({ providerId: 'venice' })
    expect(out.cached).toBe(4)
    expect(out.newlyDiscovered).toBe(1)
    // The new row is cached disabled, so nothing an agent runs on changed.
    expect(out.enabled).toBe(2)
    expect(out.note).toContain('cached DISABLED')
  })

  // Providers come from the host config and cannot be added from here, so a
  // wrong id is a refusal that names the real ones.
  test('refuses a provider this host does not declare', async () => {
    let refreshed = false
    const client = stubClient({
      getModelCatalog: async () => catalog(),
      refreshModels: async () => {
        refreshed = true
        return { count: 0, refreshedAt: 0 }
      },
    })
    const out = (await toolNamed('refresh_model_catalog').run(client, {
      providerId: 'openrouter',
    })) as { error: string; providerIds: string[] }
    expect(out.error).toContain('cannot be added from here')
    expect(out.providerIds).toEqual(['venice'])
    expect(refreshed).toBe(false)
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

  function run(
    over: Record<string, unknown> = {},
    args: Record<string, unknown> = {},
  ) {
    const client = stubClient({
      getDashboard: async () => dashboard(over),
      getProviderBudgets: async () => [],
    })
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
      getProviderBudgets: async () => [],
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

describe('list_decision_models', () => {
  // Deciders are a SEPARATE catalog from chat models, and two write tools take
  // an id out of it — a `decision_judge` check's `modelId` and a Decision node's.
  // With nothing listing them a model either invented an id (failing at the
  // provider after the sweep had launched — the exact failure `list_models`
  // exists to prevent, one namespace over) or omitted it and silently got
  // whatever sorted first.
  test('hands back the decider ids a decision_judge check can name', async () => {
    const client = stubClient({
      listDecisionModels: async () => { return [
          { id: 'venice:decider-1', label: 'Venice decider', calibrated: true },
        ] as never },
      listDecisionProviders: async () => { return [{ id: 'venice', label: 'Venice', kind: 'native' }] as never },
    })
    const result = (await toolNamed('list_decision_models').run(
      client,
      {},
    )) as {
      models: { id: string; calibrated: boolean }[]
      providers: unknown[]
      note: string
    }
    expect(result.models[0]?.id).toBe('venice:decider-1')
    // A threshold means much less against an uncalibrated decider.
    expect(result.models[0]?.calibrated).toBe(true)
    expect(result.providers).toHaveLength(1)
    expect(result.note).toContain('no enable/disable curation')
  })

  // An empty list has one specific, actionable cause and reads like a bug
  // otherwise — so it is stated rather than left to be inferred from `[]`.
  test('says why the list is empty on a host with no decision provider', async () => {
    const client = stubClient({
      listDecisionModels: async () => [],
      listDecisionProviders: async () => [],
    })
    const result = (await toolNamed('list_decision_models').run(
      client,
      {},
    )) as { models: unknown[]; note: string }
    expect(result.models).toEqual([])
    expect(result.note).toContain('No decision provider is wired')
    expect(result.note).toContain('decision_judge')
  })

  test('still answers when the provider lookup fails', async () => {
    const client = stubClient({
      listDecisionModels: async () => [{ id: 'd:1', label: 'D' }] as never,
      listDecisionProviders: () => Promise.reject(new Error('unwired')),
    })
    const result = (await toolNamed('list_decision_models').run(
      client,
      {},
    )) as { models: unknown[]; providers: unknown[] }
    expect(result.models).toHaveLength(1)
    expect(result.providers).toEqual([])
  })
})
