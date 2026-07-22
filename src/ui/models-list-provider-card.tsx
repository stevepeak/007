import { Lock, RefreshCw } from 'lucide-react'
import { useMemo } from 'react'

import type {
  AgentUsageRef,
  ModelCatalogEntry,
  ModelProviderStatus,
} from '../server/protocol'
import { agentColor, agentIcon } from './agent-appearance'
import { cn } from './cn'
import {
  BrandMark,
  CapabilityBadges,
  formatTimestamp,
  inferModelBrand,
} from './evals/shared'
import { useRefreshModels, useSetModelEnabled } from './hooks'
import {
  formatAge,
  formatContext,
  NO_AGENTS,
  type UsageMap,
} from './models-list-shared'
import { WfLink } from './nav'
import { Tooltip } from './tooltip'

export function ProviderCard({
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
