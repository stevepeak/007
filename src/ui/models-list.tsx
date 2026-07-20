import { RefreshCw, Search } from 'lucide-react'
import { useMemo, useState } from 'react'

import type {
  ModelCatalogEntry,
  ModelProviderStatus,
} from '../server/protocol'
import { cn } from './cn'
import { BrandMark, EmptyState, formatTimestamp, inferModelBrand } from './evals/shared'
import { useModelCatalog, useRefreshModels, useSetModelEnabled } from './hooks'

// The Models admin page (hub → Models). Staff see each wired-up provider, refresh
// its catalog from the provider's `/models` endpoint, and enable/disable which
// models the platform's pickers (Agent editor, Eval runs, LLM-judge) may use.
// Enabled models are a single GLOBAL set. Reached as the `models` home route in
// wf-app.tsx.

export type ModelsListProps = {
  className?: string
}

export function ModelsList({ className }: ModelsListProps) {
  const { data, isLoading, error } = useModelCatalog()
  const [query, setQuery] = useState('')

  const modelsByProvider = useMemo(() => {
    const map = new Map<string, ModelCatalogEntry[]>()
    for (const m of data?.models ?? []) {
      const list = map.get(m.providerId ?? '') ?? []
      list.push(m)
      map.set(m.providerId ?? '', list)
    }
    return map
  }, [data?.models])

  return (
    <div className={cn('mx-auto max-w-5xl space-y-6 p-6', className)}>
      <div className="text-sm text-neutral-500">
        The AI models the platform can use. Refresh a provider to pull its latest
        catalog, then enable the models you want available in the Agent editor and
        Eval runs.
      </div>

      {isLoading ? (
        <div className="text-sm text-neutral-500">Loading…</div>
      ) : null}
      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {(error as Error).message} — are you signed in?
        </div>
      ) : null}

      {data && data.providers.length === 0 ? (
        <EmptyState message="No model providers are wired up by the host." />
      ) : null}

      {data && data.providers.length > 0 ? (
        <label className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2">
          <Search className="size-4 shrink-0 text-neutral-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models by name, id, or vendor…"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-400"
          />
        </label>
      ) : null}

      {data?.providers.map((provider) => (
        <ProviderCard
          key={provider.id}
          provider={provider}
          models={modelsByProvider.get(provider.id) ?? []}
          query={query.trim().toLowerCase()}
        />
      ))}
    </div>
  )
}

function ProviderCard({
  provider,
  models,
  query,
}: {
  provider: ModelProviderStatus
  models: ModelCatalogEntry[]
  query: string
}) {
  const refresh = useRefreshModels()
  const refreshing =
    refresh.isPending && refresh.variables?.providerId === provider.id

  const filtered = useMemo(() => {
    if (!query) return models
    return models.filter(
      (m) =>
        m.label.toLowerCase().includes(query) ||
        m.modelId.toLowerCase().includes(query) ||
        (m.vendor?.toLowerCase().includes(query) ?? false),
    )
  }, [models, query])

  // Bucket the (filtered) models by vendor, vendors sorted alphabetically.
  const groups = useMemo(() => {
    const map = new Map<string, ModelCatalogEntry[]>()
    for (const m of filtered) {
      const key = m.vendor || 'Other'
      const list = map.get(key) ?? []
      list.push(m)
      map.set(key, list)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [filtered])

  return (
    <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
      <header className="flex items-center gap-3 border-b border-neutral-100 p-4">
        <BrandMark brand={inferModelBrand(provider.label)} fallback={provider.label} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-base font-medium text-neutral-900">
              {provider.label}
            </span>
            <span className="rounded-md bg-neutral-100 px-1.5 py-0.5 text-[11px] font-medium text-neutral-500">
              {provider.kind}
            </span>
          </div>
          <div className="text-xs text-neutral-500">
            {provider.modelCount === 0
              ? 'No models cached yet'
              : `${provider.modelCount} models · ${provider.enabledCount} enabled`}
            {provider.lastRefreshedAt != null
              ? ` · refreshed ${formatTimestamp(provider.lastRefreshedAt)}`
              : ''}
          </div>
        </div>
        <button
          type="button"
          disabled={refreshing}
          onClick={() => refresh.mutate({ providerId: provider.id })}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50',
            refreshing && 'cursor-not-allowed opacity-60',
          )}
        >
          <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {refresh.isError && refresh.variables?.providerId === provider.id ? (
        <div className="border-b border-red-100 bg-red-50 px-4 py-2 text-sm text-red-700">
          Refresh failed: {(refresh.error as Error).message}
        </div>
      ) : null}

      {provider.modelCount === 0 ? (
        <div className="p-6 text-center text-sm text-neutral-500">
          Click <span className="font-medium">Refresh</span> to pull this
          provider's model catalog.
        </div>
      ) : filtered.length === 0 ? (
        <div className="p-6 text-center text-sm text-neutral-500">
          No models match your search.
        </div>
      ) : (
        <div className="divide-y divide-neutral-100">
          {groups.map(([vendor, vendorModels]) => (
            <div key={vendor}>
              <div className="bg-neutral-50 px-4 py-1.5 text-xs font-medium uppercase tracking-wide text-neutral-400">
                {vendor}
                <span className="ml-1.5 lowercase text-neutral-400">
                  ({vendorModels.length})
                </span>
              </div>
              {vendorModels.map((model) => (
                <ModelRow key={model.id} model={model} />
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function ModelRow({ model }: { model: ModelCatalogEntry }) {
  const setEnabled = useSetModelEnabled()
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <BrandMark
        brand={inferModelBrand(model.modelId)}
        fallback={model.label}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-neutral-900">{model.label}</div>
        <div className="truncate text-xs text-neutral-400">{model.modelId}</div>
      </div>

      <span className="w-20 shrink-0 text-right text-xs tabular-nums text-neutral-500">
        {model.costPerMTok != null ? (
          <>
            ${model.costPerMTok.toFixed(2)}
            <span className="text-neutral-300">/M</span>
          </>
        ) : (
          <span className="text-neutral-300">—</span>
        )}
      </span>
      <span className="hidden w-20 shrink-0 text-right text-xs tabular-nums text-neutral-500 sm:inline">
        {model.contextLength != null ? (
          <>
            {formatContext(model.contextLength)}
            <span className="text-neutral-300"> ctx</span>
          </>
        ) : (
          <span className="text-neutral-300">—</span>
        )}
      </span>

      <ToggleSwitch
        checked={model.enabled}
        disabled={setEnabled.isPending && setEnabled.variables?.modelId === model.id}
        onChange={(enabled) => setEnabled.mutate({ modelId: model.id, enabled })}
      />
    </div>
  )
}

function ToggleSwitch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
        checked ? 'bg-emerald-500' : 'bg-neutral-200',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <span
        className={cn(
          'inline-block size-4 transform rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}

/** Compact context-window label, e.g. 200000 → "200k", 1048576 → "1M". */
function formatContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}
