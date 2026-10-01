import { loadConnectorCatalog } from '../../connectors/registry'
import type {
  ModelProvider,
  ModelProviderStatus,
  ProviderBudget,
} from '../../engine/config'
import { describeTriggerEvents } from '../../engine/trigger-registry'
import {
  getModelCatalog,
  getModelUsage,
  invalidateModelPriceMap,
  listEnabledDecisionModelFacts,
  listEnabledModels,
  listModelProviders,
  listToolInvocations,
  setModelEnabled,
  touchModelProvider,
  upsertModels,
} from '../../storage/data'
import type { JsonSchema, WfToolInvocation } from '../protocol'

import {
  toEpoch,
  toJsonSchema,
  type CreateWfSdkHandlersOptions,
  type HandlerCtx,
  type WfHandlers,
} from './shared'

// The set of provider ids the host currently declares — the authority for which
// providers/models this client actually offers. Cached catalog rows are gated
// against it so a provider dropped from the host config (its rows lingering in
// the DB from a past refresh) no longer surfaces in pickers.
async function hostProviderIds<TDeps>(
  config: CreateWfSdkHandlersOptions<TDeps>['config'],
  c: HandlerCtx,
): Promise<Set<string>> {
  const host = await config.listProviders({ env: await c.env() })
  return new Set(host.map((p) => p.id))
}

export function buildModelHandlers<TDeps>(
  opts: CreateWfSdkHandlersOptions<TDeps>,
): Pick<
  WfHandlers,
  | 'listModels'
  | 'listProviders'
  | 'listDecisionModels'
  | 'listDecisionProviders'
  | 'getModelCatalog'
  | 'getProviderBudgets'
  | 'refreshModels'
  | 'setModelEnabled'
  | 'listTools'
  | 'listToolInvocations'
  | 'listToolContextFields'
  | 'listTriggerEvents'
> {
  // The tool registry is static for the isolate's lifetime, but converting each
  // tool's Zod input+output to JSON Schema (via `z.toJSONSchema`) is CPU-heavy.
  // Doing it per request made `listTools` — fired on every editor/graph load —
  // exceed the Worker CPU limit. `createWfSdkHandlers` runs once per isolate, so
  // compute the wire shape a single time here and serve it from the closure.
  const toolList = [...opts.config.toolRegistry].map(([id, entry]) => ({
    id,
    name: entry.name,
    description: entry.description,
    icon: entry.icon,
    iconName: entry.iconName,
    iconUrl: entry.iconUrl,
    color: entry.color,
    kind: entry.kind,
    // Unmarked means the host's: only the SDK's own factories set `origin`, so
    // the default cannot mislabel a deployment's tool as built-in.
    origin: entry.origin ?? ('host' as const),
    sideEffect: entry.sideEffect,
    requiresContext: entry.requiresContext
      ? [...entry.requiresContext]
      : undefined,
    inputSchema: toJsonSchema(entry.inputSchema, 'input'),
    outputSchema: toJsonSchema(entry.outputSchema, 'output'),
  }))

  return {
    // Enabled models come from the DB catalog. Before the first refresh (no
    // provider rows yet) or if the tables are missing, fall back to the host's
    // static list so pickers keep working. Once the catalog is populated we
    // honor the user's curation — even an empty selection.
    listModels: async (c) => {
      try {
        const providers = await listModelProviders(c.db)
        if (providers.length === 0) {
          // No cached catalog yet — fall back to the host's static list.
          return await opts.config.listModels({ env: await c.env() })
        }
        // Show only enabled models from providers the host STILL declares. A
        // provider cached from a past refresh but no longer wired up (e.g.
        // OpenRouter on a Venice-only host) is dropped, along with its models.
        // An empty result honors the user's curation (all models disabled).
        const allowed = await hostProviderIds(opts.config, c)
        const enabled = await listEnabledModels(c.db)
        return enabled.filter(
          (m) => m.providerId != null && allowed.has(m.providerId),
        )
      } catch (err) {
        // A persistent host-provider misconfig would otherwise be invisible
        // here — log before falling back to the raw host list.
        c.logger.error('[wf] listModels: host provider lookup failed', err)
        return await opts.config.listModels({ env: await c.env() })
      }
    },

    // The host DECLARES which deciders its `getDecider` can resolve; the catalog
    // knows what they currently cost and how big their window is. Both are needed
    // and neither can supply the other's half:
    //
    //   • host  → `questionTypes`, `calibrated`, `maxQuestionsPerCall`. Provider
    //     semantics. No `/models` payload reports whether a model's
    //     probabilities are calibrated, and getting that wrong silently changes
    //     what every threshold an author sets actually means.
    //   • catalog → label, `contextLength`, and (via `wf_model`'s price columns)
    //     the numbers the cost fold reads. Live, refreshed, and admin-curated.
    //
    // So: the host list is the SPINE — a decider absent from it cannot be
    // resolved and must not be offered however many catalog rows mention it —
    // and catalog facts are layered over each entry. Before the first refresh,
    // or for a host that catalogues no decision models, the host list passes
    // through untouched, which is exactly how this behaved before the catalog
    // learned about them.
    listDecisionModels: async (c) => {
      if (!opts.config.listDecisionModels) return []
      const declared = await opts.config.listDecisionModels({
        env: await c.env(),
      })
      let facts: Awaited<ReturnType<typeof listEnabledDecisionModelFacts>>
      try {
        facts = await listEnabledDecisionModelFacts(c.db)
      } catch (err) {
        // The catalog is an enrichment, never a gate — a failed read must not
        // take the Decision pickers down with it.
        c.logger.error('[wf] listDecisionModels: catalog read failed', err)
        return declared
      }
      if (facts.length === 0) return declared
      const byId = new Map(facts.map((f) => [f.id, f]))
      return declared.map((m) => {
        const fact = byId.get(m.id)
        if (!fact) return m
        return {
          ...m,
          label: fact.label,
          contextLength: fact.contextLength ?? m.contextLength,
        }
      })
    },

    listDecisionProviders: async (c) => {
      if (!opts.config.listDecisionProviders) return []
      return await opts.config.listDecisionProviders({ env: await c.env() })
    },

    listProviders: async (c) => {
      try {
        const host = await opts.config.listProviders({ env: await c.env() })
        // The host config is the source of truth for WHICH providers this
        // client offers. Prefer the DB rows (they carry refresh metadata) but
        // keep only the providers the host still declares; fall back to the
        // host list before the first refresh caches any rows.
        const allowed = new Set(host.map((p) => p.id))
        const db = await listModelProviders(c.db)
        const filtered = db.filter((p) => allowed.has(p.id))
        return filtered.length > 0 ? filtered : host
      } catch (err) {
        // Same as listModels: a failing host `listProviders` shouldn't blank
        // the catalog silently — log, then serve the cached DB rows.
        c.logger.error('[wf] listProviders: host provider lookup failed', err)
        return await listModelProviders(c.db)
      }
    },

    // The host config is the source of truth for WHICH providers this client
    // offers; the DB adds each one's last-refresh time, cached models, and
    // counts. A freshly-wired provider (e.g. OpenRouter) shows up with a
    // Refresh button BEFORE its first refresh, and a provider the host no
    // longer declares — but whose rows linger in the DB from a past refresh —
    // is dropped, along with its models, so clients only ever see what they
    // actually provide.
    getModelCatalog: async (c) => {
      const [dbCatalog, usage] = await Promise.all([
        getModelCatalog(c.db),
        getModelUsage(c.db),
      ])
      let hostProviders: ModelProvider[]
      try {
        hostProviders = await opts.config.listProviders({ env: await c.env() })
      } catch {
        // Can't determine the host's providers right now — fall back to the
        // cached DB catalog rather than blanking the page on a transient error.
        return {
          providers: dbCatalog.providers,
          models: dbCatalog.models,
          usage,
        }
      }
      const dbById = new Map(dbCatalog.providers.map((p) => [p.id, p]))
      const providers: ModelProviderStatus[] = hostProviders.map((hp) => {
        const db = dbById.get(hp.id)
        const models = dbCatalog.models.filter((m) => m.providerId === hp.id)
        return {
          ...hp,
          enabled: db?.enabled ?? true,
          lastRefreshedAt: db?.lastRefreshedAt ?? null,
          modelCount: models.length,
          enabledCount: models.filter((m) => m.enabled).length,
        }
      })
      const allowed = new Set(hostProviders.map((p) => p.id))
      const models = dbCatalog.models.filter(
        (m) => m.providerId != null && allowed.has(m.providerId),
      )
      return { providers, models, usage }
    },

    // Live spend budgets, read from each provider's own API on every call —
    // nothing is cached, so the number the UI shows is the number the provider
    // will bill against. Kept OUT of `getModelCatalog` so those external calls
    // never delay the page: the UI requests this separately and fills it in.
    getProviderBudgets: async (c) => {
      const env = await c.env()
      const providers = await opts.config.listProviders({ env })
      const fetchBudget = opts.config.fetchProviderBudget
      // Every provider resolves to an entry, never an omission — a card that
      // can't report is a card that SAYS it can't report. One provider's
      // revoked key or outage is contained to its own entry.
      return await Promise.all(
        providers.map(async (p): Promise<ProviderBudget> => {
          const unsupported: ProviderBudget = {
            providerId: p.id,
            status: 'unsupported',
            remaining: null,
            limit: null,
            usage: null,
            resetInterval: null,
          }
          if (!fetchBudget) return unsupported
          try {
            return (await fetchBudget({ env }, p.id)) ?? unsupported
          } catch (err) {
            c.logger.error(`[wf] getProviderBudgets: ${p.id} failed`, err)
            return {
              ...unsupported,
              status: 'error',
              message: err instanceof Error ? err.message : String(err),
            }
          }
        }),
      )
    },

    refreshModels: async (c) => {
      const { providerId } = c.params
      const fetchCatalog = opts.config.fetchModelCatalog
      if (!fetchCatalog) {
        throw new Error(
          'This host does not support refreshing models (no `fetchModelCatalog` configured).',
        )
      }
      const env = await c.env()
      const entries = await fetchCatalog({ env }, providerId)
      // Refresh never auto-enables anything: newly discovered models are inserted
      // DISABLED and the admin opts them in explicitly. (Existing rows keep their
      // `enabled` flag — see `upsertModels`.) A fresh DB thus starts with zero
      // enabled models until someone turns them on.
      const count = await upsertModels(c.db, providerId, entries)
      // Prices just moved — drop the memo so run costs re-derive off the new
      // catalog now rather than after the TTL.
      invalidateModelPriceMap(c.db)
      const refreshedAt = new Date()
      const providers = await opts.config.listProviders({ env })
      const provider = providers.find((p) => p.id === providerId) ?? {
        id: providerId,
        label: providerId,
        kind: 'custom' as const,
      }
      await touchModelProvider(c.db, provider, refreshedAt)
      return { count, refreshedAt: refreshedAt.getTime() }
    },

    setModelEnabled: async (c) => {
      const { modelId, enabled } = c.params
      // A model in use by an agent cannot be disabled — it would break that
      // agent's model resolution. The UI locks the toggle; enforce it here too.
      if (!enabled) {
        const users = (await getModelUsage(c.db))[modelId] ?? []
        if (users.length > 0) {
          const names = users.map((u) => u.name).join(', ')
          throw new Error(
            `Can't disable this model — it's in use by ${users.length} agent(s): ${names}. Point those agents at another model first.`,
          )
        }
      }
      await setModelEnabled(c.db, { modelId, enabled })
      await c.change({
        entityKind: 'model',
        entityId: modelId,
        action: enabled ? 'enable' : 'disable',
        fields: ['enabled'],
        before: { enabled: !enabled },
        after: { enabled },
        note: modelId,
      })
      invalidateModelPriceMap(c.db)
      return { ok: true as const }
    },

    // Host tools (memoized above) plus every CALLABLE connector tool — enabled,
    // still advertised by its server, on an enabled connector. The picker must
    // offer exactly what can actually run.
    //
    // The connector half is a plain D1 read with no per-request CPU cost: MCP
    // hands us JSON Schema already, so none of it goes through the
    // `z.toJSONSchema` conversion that forced the host half to be memoized.
    listTools: async (c) => {
      const catalog = await loadConnectorCatalog(c.db)
      return [
        ...toolList,
        ...catalog.map((entry) => ({
          id: entry.id,
          name: `${entry.connectorLabel}: ${entry.title ?? entry.toolName}`,
          description:
            entry.description ??
            `${entry.toolName} via ${entry.connectorLabel}`,
          icon: entry.icon ?? undefined,
          iconName: entry.iconName ?? undefined,
          iconUrl: entry.iconUrl ?? undefined,
          color: entry.color ?? undefined,
          kind: 'ai-tool' as const,
          // Neither the host's nor the SDK's: a third party wrote it, and it
          // can change without either repo being touched — the distinction
          // `origin` is actually drawing.
          origin: 'connector' as const,
          sideEffect: entry.sideEffect,
          inputSchema: (entry.inputSchema as JsonSchema | null) ?? undefined,
          outputSchema: (entry.outputSchema as JsonSchema | null) ?? undefined,
        })),
      ]
    },

    listToolInvocations: async (c) => {
      const rows = await listToolInvocations(c.db, c.params)
      const invocations: WfToolInvocation[] = rows.map((r) => {
        // `meta` is the untyped tool-step meta ({ toolId, args }); pull the
        // args out defensively so a malformed row degrades to `{}`.
        const meta = (r.meta ?? {}) as { args?: unknown }
        const args =
          meta.args && typeof meta.args === 'object'
            ? (meta.args as Record<string, unknown>)
            : {}
        return {
          runId: r.runId,
          nodeId: r.nodeId,
          status: r.status,
          args,
          output: r.output,
          error: r.error,
          startedAt: toEpoch(r.startedAt),
          finishedAt: toEpoch(r.finishedAt),
          workflowId: r.workflowId ?? null,
          workflowName: r.workflowName ?? null,
        }
      })
      return invocations
    },

    listToolContextFields: () => opts.toolContextFields ?? [],

    listTriggerEvents: () => describeTriggerEvents(opts.config.triggers),
  }
}
