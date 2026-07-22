import type { ModelProvider, ModelProviderStatus } from '../../engine/config'
import { describeTriggerEvents } from '../../engine/trigger-registry'
import {
  getModelCatalog,
  getModelUsage,
  listEnabledModels,
  listModelProviders,
  listToolInvocations,
  setModelEnabled,
  touchModelProvider,
  upsertModels,
} from '../../storage/data'
import type { WfToolInvocation } from '../protocol'

import {
  str,
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
  | 'getModelCatalog'
  | 'refreshModels'
  | 'setModelEnabled'
  | 'listTools'
  | 'listToolInvocations'
  | 'listToolContextFields'
  | 'listTriggerEvents'
> {
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
        console.error('[wf] listModels: host provider lookup failed', err)
        return await opts.config.listModels({ env: await c.env() })
      }
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
        console.error('[wf] listProviders: host provider lookup failed', err)
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

    refreshModels: async (c) => {
      const providerId = str(c.params, 'providerId')
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
      const modelId = str(c.params, 'modelId')
      const enabled = (c.params as { enabled?: boolean }).enabled === true
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
      return { ok: true as const }
    },

    listTools: () =>
      [...opts.config.toolRegistry].map(([id, entry]) => ({
        id,
        name: entry.name,
        description: entry.description,
        icon: entry.icon,
        kind: entry.kind,
        inputSchema: toJsonSchema(entry.inputSchema, 'input'),
        outputSchema: toJsonSchema(entry.outputSchema, 'output'),
      })),

    listToolInvocations: async (c) => {
      const toolId = str(c.params, 'toolId')
      const limit = (c.params as { limit?: number }).limit
      const rows = await listToolInvocations(c.db, { toolId, limit })
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
