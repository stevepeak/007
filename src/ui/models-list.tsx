import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'

import type {
  ModelCapabilities,
  ModelCatalogEntry,
} from '../server/protocol'
import { cn } from './cn'
import { EmptyState } from './evals/shared'
import { useModelCatalog } from './hooks'
import { ProviderCard } from './models-list-provider-card'
import {
  AGE_MAX_DAYS,
  CAP_FILTERS,
  DAY_MS,
  type AgeFilter,
  type ChosenFilter,
} from './models-list-shared'
import { QueryState } from './query-state'

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
  const [caps, setCaps] = useState<ReadonlySet<keyof ModelCapabilities>>(
    () => new Set(),
  )
  const [chosen, setChosen] = useState<ChosenFilter>('all')
  const [age, setAge] = useState<AgeFilter>('any')

  const modelsByProvider = useMemo(() => {
    const map = new Map<string, ModelCatalogEntry[]>()
    for (const m of data?.models ?? []) {
      const list = map.get(m.providerId ?? '') ?? []
      list.push(m)
      map.set(m.providerId ?? '', list)
    }
    return map
  }, [data?.models])

  // One predicate for all filters. `now` is captured once per render so age
  // buckets are stable across the pass.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    const now = Date.now()
    return (m: ModelCatalogEntry): boolean => {
      if (
        q &&
        !m.label.toLowerCase().includes(q) &&
        !m.modelId.toLowerCase().includes(q) &&
        !(m.vendor?.toLowerCase().includes(q) ?? false)
      ) {
        return false
      }
      if (chosen === 'enabled' && !m.enabled) return false
      if (chosen === 'disabled' && m.enabled) return false
      // Type filter matches ALL selected capabilities.
      for (const k of caps) if (!m.capabilities?.[k]) return false
      if (age !== 'any') {
        // A model with no known release date can't be aged — exclude it.
        if (m.releasedAt == null) return false
        const days = (now - m.releasedAt) / DAY_MS
        if (age === 'older') {
          if (days <= AGE_MAX_DAYS.recent) return false
        } else if (days > AGE_MAX_DAYS[age]) {
          return false
        }
      }
      return true
    }
  }, [query, caps, chosen, age])

  const anyActive =
    query.trim() !== '' || caps.size > 0 || chosen !== 'all' || age !== 'any'

  const toggleCap = (key: keyof ModelCapabilities) =>
    setCaps((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const clearFilters = () => {
    setQuery('')
    setCaps(new Set())
    setChosen('all')
    setAge('any')
  }

  return (
    <div className={cn('mx-auto max-w-5xl space-y-6 p-6', className)}>
      <div className="text-sm text-neutral-500">
        The AI models the platform can use. Refresh a provider to pull its latest
        catalog, then enable the models you want available in the Agent editor and
        Eval runs.
      </div>

      <QueryState
        query={{ isLoading, error, data }}
        loading={<div className="text-sm text-neutral-500">Loading…</div>}
        error={(error) => (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error.message} — are you signed in?
          </div>
        )}
        isEmpty={(data) => data?.providers.length === 0}
        empty={
          <EmptyState message="No model providers are wired up by the host." />
        }
      />

      {data && data.providers.length > 0 ? (
        <div className="space-y-2">
          <label className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2">
            <Search className="size-4 shrink-0 text-neutral-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models by name, id, or vendor…"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-400"
            />
          </label>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
            {/* Type: capability chips (match ALL selected). */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-neutral-400">Type</span>
              {CAP_FILTERS.map(({ key, label, icon: Icon }) => {
                const on = caps.has(key)
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleCap(key)}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors',
                      on
                        ? 'border-neutral-900 bg-neutral-900 text-white'
                        : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50',
                    )}
                  >
                    <Icon className="size-3" />
                    {label}
                  </button>
                )
              })}
            </div>

            <FilterSelect
              label="Chosen"
              value={chosen}
              onChange={(v) => setChosen(v as ChosenFilter)}
              options={[
                ['all', 'All'],
                ['enabled', 'Enabled'],
                ['disabled', 'Disabled'],
              ]}
            />
            <FilterSelect
              label="Age"
              value={age}
              onChange={(v) => setAge(v as AgeFilter)}
              options={[
                ['any', 'Any'],
                ['new', 'New (≤30d)'],
                ['recent', 'Recent (≤90d)'],
                ['older', 'Older (>90d)'],
              ]}
            />

            {anyActive ? (
              <button
                type="button"
                onClick={clearFilters}
                className="text-xs text-neutral-500 underline-offset-2 hover:underline"
              >
                Clear filters
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {data?.providers.map((provider) => (
        <ProviderCard
          key={provider.id}
          provider={provider}
          models={modelsByProvider.get(provider.id) ?? []}
          usage={data.usage}
          matches={matches}
          filtersActive={anyActive}
        />
      ))}
    </div>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: [string, string][]
}) {
  return (
    <label className="inline-flex items-center gap-1.5">
      <span className="text-xs text-neutral-400">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-neutral-200 bg-white px-2 py-0.5 text-xs text-neutral-700 outline-none focus:border-neutral-400"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  )
}
