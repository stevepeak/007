import { ChevronDown, ChevronRight } from 'lucide-react'

import type { ModelGroup } from '../editor/model-grouping'

import { ModelMatrixRow } from './run-config-dialog-model-row'

// The MODELS axis of the test matrix: every available model, bucketed by
// provider, each with a run count. A count of 0 means unselected; anything
// higher is best-of-N per sample.
export function ModelAxis({
  loading,
  groups,
  counts,
  collapsed,
  onCount,
  onToggleProvider,
  selectedCount,
  totalRuns,
}: {
  loading: boolean
  groups: ModelGroup[]
  /** modelId → run count. Absent or 0 = unselected. */
  counts: Record<string, number>
  /** providerId → whether its bucket is folded shut. */
  collapsed: Record<string, boolean>
  onCount: (modelId: string, next: number) => void
  onToggleProvider: (providerId: string) => void
  selectedCount: number
  totalRuns: number
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Models to run against
        </h3>
        {selectedCount > 0 ? (
          <span className="text-xs tabular-nums text-neutral-400">
            {selectedCount} model
            {selectedCount === 1 ? '' : 's'} · {totalRuns} run
            {totalRuns === 1 ? '' : 's'} / sample
          </span>
        ) : null}
      </div>
      <div className="overflow-hidden rounded-lg border border-neutral-200">
        {loading ? (
          <div className="px-3 py-8 text-center text-sm text-neutral-400">
            Loading models…
          </div>
        ) : groups.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-neutral-500">
            No models available. Wire a provider into the host config.
          </div>
        ) : (
          groups.map(({ provider, models }) => (
            <ProviderBucket
              key={provider.id}
              providerId={provider.id}
              label={provider.label}
              models={models}
              counts={counts}
              collapsed={collapsed[provider.id] ?? false}
              onCount={onCount}
              onToggle={onToggleProvider}
            />
          ))
        )}
      </div>
    </div>
  )
}

function ProviderBucket({
  providerId,
  label,
  models,
  counts,
  collapsed,
  onCount,
  onToggle,
}: {
  providerId: string
  label: string
  models: ModelGroup['models']
  counts: Record<string, number>
  collapsed: boolean
  onCount: (modelId: string, next: number) => void
  onToggle: (providerId: string) => void
}) {
  const selected = models.filter((m) => (counts[m.id] ?? 0) > 0).length
  return (
    <div className="border-b border-neutral-100 last:border-b-0">
      <button
        type="button"
        onClick={() => onToggle(providerId)}
        className="flex w-full items-center gap-1.5 bg-neutral-50 px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-neutral-500 transition hover:text-neutral-800"
      >
        {collapsed ? (
          <ChevronRight className="size-3.5" />
        ) : (
          <ChevronDown className="size-3.5" />
        )}
        <span className="flex-1">{label}</span>
        {selected > 0 ? (
          <span className="rounded-full bg-neutral-900 px-1.5 py-0.5 text-[10px] text-white">
            {selected}
          </span>
        ) : null}
      </button>
      {collapsed
        ? null
        : models.map((m) => (
            <ModelMatrixRow
              key={m.id}
              model={m}
              count={counts[m.id] ?? 0}
              onChange={(n) => onCount(m.id, n)}
            />
          ))}
    </div>
  )
}
