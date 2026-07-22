import {
  Braces,
  Eye,
  Lock,
  RefreshCw,
  Search,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { useMemo, useState } from 'react'

import type {
  AgentUsageRef,
  ModelCapabilities,
  ModelCatalogEntry,
  ModelProviderStatus,
} from '../server/protocol'
import { agentColor, agentIcon } from './agent-appearance'
import { cn } from './cn'
import {
  BrandMark,
  CapabilityBadges,
  EmptyState,
  formatTimestamp,
  inferModelBrand,
} from './evals/shared'
import { useModelCatalog, useRefreshModels, useSetModelEnabled } from './hooks'
import { WfLink } from './nav'
import { QueryState } from './query-state'
import { Tooltip } from './tooltip'

type UsageMap = Record<string, AgentUsageRef[]>
const NO_AGENTS: AgentUsageRef[] = []

// ── Filters ──────────────────────────────────────────────────────────────────

const CAP_FILTERS: {
  key: keyof ModelCapabilities
  label: string
  icon: LucideIcon
}[] = [
  { key: 'tools', label: 'Tools', icon: Wrench },
  { key: 'reasoning', label: 'Reasoning', icon: Sparkles },
  { key: 'vision', label: 'Vision', icon: Eye },
  { key: 'structuredOutput', label: 'Structured', icon: Braces },
]

type ChosenFilter = 'all' | 'enabled' | 'disabled'
type AgeFilter = 'any' | 'new' | 'recent' | 'older'

const AGE_MAX_DAYS: Record<Exclude<AgeFilter, 'any' | 'older'>, number> = {
  new: 30,
  recent: 90,
}

const DAY_MS = 86_400_000

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

function ProviderCard({
  provider,
  models,
  usage,
  matches,
  filtersActive,
}: {
  provider: ModelProviderStatus
  models: ModelCatalogEntry[]
  usage: UsageMap
  matches: (m: ModelCatalogEntry) => boolean
  filtersActive: boolean
}) {
  const refresh = useRefreshModels()
  const refreshing =
    refresh.isPending && refresh.variables?.providerId === provider.id

  const filtered = useMemo(() => models.filter(matches), [models, matches])

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
    <section className="rounded-xl border border-neutral-200 bg-white">
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
          {filtersActive
            ? 'No models match the current filters.'
            : 'No models cached.'}
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
                <ModelRow
                  key={model.id}
                  model={model}
                  usedBy={usage[model.id] ?? NO_AGENTS}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function ModelRow({
  model,
  usedBy,
}: {
  model: ModelCatalogEntry
  usedBy: AgentUsageRef[]
}) {
  const setEnabled = useSetModelEnabled()
  // An enabled model that agents depend on can't be turned off — doing so would
  // break their model resolution. (A disabled model isn't lockable; you can
  // always turn it back on.)
  const locked = model.enabled && usedBy.length > 0
  const lockReason = locked
    ? `In use by ${usedBy.length} agent${usedBy.length === 1 ? '' : 's'} — remove it there to disable`
    : undefined
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <BrandMark
        brand={inferModelBrand(model.modelId)}
        fallback={model.label}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm text-neutral-900">{model.label}</span>
          <CapabilityBadges capabilities={model.capabilities} />
        </div>
        <div className="truncate text-xs text-neutral-400">{model.modelId}</div>
      </div>

      <AgentAvatars agents={usedBy} />

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
        {model.tokensPerSec != null ? (
          <>
            {Math.round(model.tokensPerSec)}
            <span className="text-neutral-300"> tok/s</span>
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
      <span className="hidden w-16 shrink-0 text-right text-xs tabular-nums text-neutral-500 md:inline">
        {model.releasedAt != null ? (
          formatAge(model.releasedAt)
        ) : (
          <span className="text-neutral-300">—</span>
        )}
      </span>

      <Tooltip content={lockReason} side="left">
        <ToggleSwitch
          checked={model.enabled}
          locked={locked}
          disabled={
            setEnabled.isPending && setEnabled.variables?.modelId === model.id
          }
          onChange={(enabled) => setEnabled.mutate({ modelId: model.id, enabled })}
        />
      </Tooltip>
    </div>
  )
}

/** Overlapping icon-only avatars of the agents using a model (tooltip = name). */
function AgentAvatars({ agents }: { agents: AgentUsageRef[] }) {
  if (agents.length === 0) return null
  const shown = agents.slice(0, 4)
  const extra = agents.length - shown.length
  return (
    <div className="hidden shrink-0 items-center sm:flex">
      {shown.map((a) => {
        const Icon = agentIcon(a.icon)
        const color = agentColor(a.color)
        return (
          <Tooltip key={a.id} content={a.name} className="-mr-1.5 last:mr-0">
            <WfLink
              to={`agents/${a.id}/edit`}
              className={cn(
                'flex size-5 items-center justify-center rounded-full ring-2 ring-white transition hover:z-10 hover:ring-neutral-300',
                color.chip,
              )}
            >
              <Icon className="size-3" />
            </WfLink>
          </Tooltip>
        )
      })}
      {extra > 0 ? (
        <span className="ml-0.5 text-xs text-neutral-400">+{extra}</span>
      ) : null}
    </div>
  )
}

function ToggleSwitch({
  checked,
  disabled,
  locked,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  /** In use by an agent: shown as locked-on and non-interactive. */
  locked?: boolean
  onChange: (checked: boolean) => void
}) {
  const blocked = disabled || locked
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={blocked}
      disabled={blocked}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
        checked ? 'bg-emerald-500' : 'bg-neutral-200',
        locked && 'cursor-not-allowed',
        disabled && !locked && 'cursor-not-allowed opacity-60',
      )}
    >
      <span
        className={cn(
          'inline-flex size-4 transform items-center justify-center rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      >
        {locked ? <Lock className="size-2.5 text-neutral-400" /> : null}
      </span>
    </button>
  )
}

/** Compact context-window label, e.g. 200000 → "200k", 1048576 → "1M". */
function formatContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

/** Compact relative age from an epoch-ms release date, e.g. "5d", "3mo", "2y". */
function formatAge(releasedAt: number): string {
  const days = Math.max(0, (Date.now() - releasedAt) / DAY_MS)
  if (days < 1) return 'today'
  if (days < 30) return `${Math.round(days)}d`
  if (days < 365) return `${Math.round(days / 30)}mo`
  return `${(days / 365).toFixed(1)}y`
}
