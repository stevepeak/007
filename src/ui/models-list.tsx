import { Cpu, ExternalLink, Scale, Search } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { ModelCapabilities, ModelCatalogEntry } from '../server/protocol'

import { cn } from './cn'
import { EmptyState } from './evals/shared'
import { FilterPill, FilterPillMulti } from './filters'
import { useModelCatalog, useProviderBudgets } from './hooks'
import { ProviderCard } from './models-list-provider-card'
import {
  AGE_MAX_DAYS,
  CAP_FILTERS,
  DAY_MS,
  KIND_FILTERS,
  OPENROUTER_COMPARE_URL,
  type AgeFilter,
  type ChosenFilter,
  type KindFilter,
} from './models-list-shared'
import { QueryState } from './query-state'
import { usePickedAt } from './use-now'

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
  // Fetched once here and handed down, on its own query so the catalog below
  // renders without waiting on a round-trip to each provider's API.
  const budgets = useProviderBudgets()
  const [query, setQuery] = useState('')
  const [caps, setCaps] = useState<(keyof ModelCapabilities)[]>([])
  const [chosen, setChosen] = useState<ChosenFilter>('all')
  const [kind, setKind] = useState<KindFilter>('all')
  const [age, pickedAt, setAge] = usePickedAt<AgeFilter>('any')

  const modelsByProvider = useMemo(() => {
    const map = new Map<string, ModelCatalogEntry[]>()
    for (const m of data?.models ?? []) {
      const list = map.get(m.providerId ?? '') ?? []
      list.push(m)
      map.set(m.providerId ?? '', list)
    }
    return map
  }, [data?.models])

  const budgetById = useMemo(
    () => new Map((budgets.data ?? []).map((b) => [b.providerId, b])),
    [budgets.data],
  )

  // One predicate for all filters. Ages are measured against the instant the
  // bucket was picked, so every model in a pass is aged the same way.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
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
      // Absent reads as 'chat', matching the column's default — a row written
      // before the catalogs were separated is a chat model.
      if (kind !== 'all' && (m.kind ?? 'chat') !== kind) return false
      // Type filter matches ALL selected capabilities.
      for (const k of caps) if (m.capabilities?.[k] !== true) return false
      if (age !== 'any') {
        // A model with no known release date can't be aged — exclude it.
        if (m.releasedAt == null) return false
        const days = (pickedAt - m.releasedAt) / DAY_MS
        if (age === 'older') {
          if (days <= AGE_MAX_DAYS.recent) return false
        } else if (days > AGE_MAX_DAYS[age]) {
          return false
        }
      }
      return true
    }
  }, [pickedAt, query, caps, chosen, kind, age])

  const anyActive =
    query.trim() !== '' ||
    caps.length > 0 ||
    chosen !== 'all' ||
    kind !== 'all' ||
    age !== 'any'

  const clearFilters = () => {
    setQuery('')
    setCaps([])
    setChosen('all')
    setKind('all')
    setAge('any')
  }

  return (
    <div className={cn('mx-auto max-w-5xl space-y-6 p-6', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="text-sm text-neutral-500">
          The AI models the platform can use. Refresh a provider to pull its
          latest catalog, then enable the models you want available in the Agent
          editor and Eval runs.
        </div>
        <a
          href={OPENROUTER_COMPARE_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 py-1 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
        >
          Compare models
          <ExternalLink className="size-3" />
        </a>
      </div>

      <QueryState
        query={{ isLoading, error, data }}
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

          <div className="flex flex-wrap items-center gap-2">
            <FilterPillMulti
              label="Type"
              value={caps}
              onChange={(v) => setCaps(v as (keyof ModelCapabilities)[])}
              options={CAP_FILTERS.map(({ key, label, icon: Icon }) => ({
                value: key,
                label,
                node: (
                  <span className="inline-flex items-center gap-1.5">
                    <Icon className="size-3.5" />
                    {label}
                  </span>
                ),
              }))}
            />
            <FilterPill
              label="Kind"
              value={kind === 'all' ? '' : kind}
              onChange={(v) => setKind((v || 'all') as KindFilter)}
              options={KIND_FILTERS.map(({ value, label }) => {
                const Icon = value === 'decision' ? Scale : Cpu
                return {
                  value,
                  label,
                  node: (
                    <span className="inline-flex items-center gap-1.5">
                      <Icon className="size-3.5" />
                      {label}
                    </span>
                  ),
                }
              })}
            />
            <FilterPill
              label="Chosen"
              value={chosen === 'all' ? '' : chosen}
              onChange={(v) => setChosen((v || 'all') as ChosenFilter)}
              options={[
                { value: 'enabled', label: 'Enabled' },
                { value: 'disabled', label: 'Disabled' },
              ]}
            />
            <FilterPill
              label="Age"
              value={age === 'any' ? '' : age}
              onChange={(v) => setAge((v || 'any') as AgeFilter)}
              options={[
                { value: 'new', label: 'New (≤30d)' },
                { value: 'recent', label: 'Recent (≤90d)' },
                { value: 'older', label: 'Older (>90d)' },
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
          budget={budgetById.get(provider.id)}
          budgetLoading={budgets.isPending}
        />
      ))}
    </div>
  )
}
