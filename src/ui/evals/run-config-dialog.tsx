import { Check, ChevronRight, Minus, Plus, X } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'

import type { ModelOption, ModelProvider } from '../../server/protocol'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import { useModels, useProviders } from '../hooks'
import { BrandMark, inferModelBrand } from './shared'

// The "Run" configuration dialog, shared by the Goal / Sample / Test Run
// buttons. Step 1 (this screen): pick which AI models to test the target on,
// and how many best-of-N attempts each. "Next" is inert for now — the run
// launcher isn't wired yet.
//
// Models + providers come from the host config (config.listProviders /
// config.listModels) via the data client — so the dialog shows ONLY the
// providers this client wired up, each as a collapsible group. Nothing is
// persisted or executed yet.

// A model is "selected" iff its best-of-N is >= 1. Best-of-N of 0 means the
// model is not part of the run. The stepper drives selection directly: bump to
// 1+ to include the model, drop back to 0 to remove it.
type ModelChoice = {
  /** Best-of-N attempts for this model. 0 = not selected. */
  bestOfN: number
}

export type RunConfigDialogProps = {
  open: boolean
  onClose: () => void
  /** What this run targets, e.g. "goal", "sample", "test". */
  scope: 'goal' | 'sample' | 'test'
  /** Display name of the thing being run (shown in the subtitle). */
  targetName: string
}

export function RunConfigDialog({
  open,
  onClose,
  scope,
  targetName,
}: RunConfigDialogProps) {
  const { Button } = useWfComponents()
  const [choices, setChoices] = useState<Record<string, ModelChoice>>({})
  // Which provider groups are collapsed (id → true). Default: all expanded.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  // The host's wired-up providers + models, straight from config over the data
  // client. Only these providers render.
  const providersQuery = useProviders()
  const modelsQuery = useModels()
  const loading = providersQuery.isLoading || modelsQuery.isLoading

  useEffect(() => {
    if (!open) return
    setChoices({})
    setCollapsed({})
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Models bucketed under the provider the host declared for them, in declared
  // order. Any model whose `providerId` matches no declared provider (or all of
  // them, when the host declares none) falls into a synthetic group so nothing
  // is silently hidden.
  const groups = useMemo(() => {
    const providers = providersQuery.data ?? []
    const models = modelsQuery.data ?? []
    const declared = providers
      .map((provider) => ({
        provider,
        models: models.filter((m) => m.providerId === provider.id),
      }))
      .filter((g) => g.models.length > 0)

    const claimed = new Set(declared.flatMap((g) => g.models.map((m) => m.id)))
    const orphans = models.filter((m) => !claimed.has(m.id))
    if (orphans.length > 0) {
      declared.push({
        provider: {
          id: '__ungrouped__',
          label: providers.length > 0 ? 'Other' : 'Models',
          kind: 'custom',
        },
        models: orphans,
      })
    }
    return declared
  }, [providersQuery.data, modelsQuery.data])

  const selectedCount = useMemo(
    () => Object.values(choices).filter((c) => c.bestOfN >= 1).length,
    [choices],
  )

  if (!open) return null

  // Checkbox toggles between not-selected (0) and a single attempt (1).
  const toggle = (id: string) =>
    setChoices((prev) => {
      const cur = prev[id] ?? { bestOfN: 0 }
      return { ...prev, [id]: { bestOfN: cur.bestOfN >= 1 ? 0 : 1 } }
    })

  // The stepper can drive selection all the way to 0 (unselect).
  const setBestOfN = (id: string, n: number) =>
    setChoices((prev) => ({ ...prev, [id]: { bestOfN: Math.max(0, n) } }))

  const toggleGroup = (id: string) =>
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }))

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg border border-neutral-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-neutral-200 px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold text-neutral-900">
              Run configuration
            </h2>
            <p className="mt-0.5 text-xs text-neutral-500">
              Choose the models to test this {scope} on ·{' '}
              <span className="font-medium text-neutral-700">{targetName}</span>
            </p>
          </div>
          <button
            aria-label="Close"
            onClick={onClose}
            className="text-neutral-400 transition hover:text-neutral-700"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="rounded-lg border border-dashed border-neutral-200 px-4 py-8 text-center text-sm text-neutral-400">
              Loading models…
            </div>
          ) : groups.length === 0 ? (
            <div className="rounded-lg border border-dashed border-neutral-200 px-4 py-8 text-center text-sm text-neutral-500">
              No models available. Wire a provider into the host config.
            </div>
          ) : (
          <div className="overflow-hidden rounded-lg border border-neutral-200">
            <div className="grid grid-cols-[auto_1fr_auto_auto_auto] items-center gap-4 border-b border-neutral-100 bg-neutral-50 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
              <span>Test</span>
              <span>Model</span>
              <span className="text-right">Cost</span>
              <span className="text-right">Speed</span>
              <span className="text-right">Best of N</span>
            </div>
            {groups.map(({ provider, models }) => {
              const isCollapsed = collapsed[provider.id] ?? false
              const groupSelected = models.filter(
                (m) => (choices[m.id]?.bestOfN ?? 0) >= 1,
              ).length
              return (
                <ProviderGroup
                  key={provider.id}
                  provider={provider}
                  modelCount={models.length}
                  selectedCount={groupSelected}
                  collapsed={isCollapsed}
                  onToggle={() => toggleGroup(provider.id)}
                >
                  {models.map((m) => (
                    <ModelRow
                      key={m.id}
                      model={m}
                      choice={choices[m.id] ?? { bestOfN: 0 }}
                      onToggle={() => toggle(m.id)}
                      onBestOfN={(n) => setBestOfN(m.id, n)}
                    />
                  ))}
                </ProviderGroup>
              )
            })}
          </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-neutral-200 px-5 py-3">
          <span className="text-xs text-neutral-500">
            {selectedCount === 0
              ? 'No models selected'
              : `${selectedCount} model${selectedCount === 1 ? '' : 's'} selected`}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" disabled title="Not wired up yet">
              Next
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// A collapsible section grouping one provider's models. The header is a full-row
// toggle; the count chip shows how many of this provider's models are selected.
function ProviderGroup({
  provider,
  modelCount,
  selectedCount,
  collapsed,
  onToggle,
  children,
}: {
  provider: ModelProvider
  modelCount: number
  selectedCount: number
  collapsed: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className="border-b border-neutral-200 last:border-b-0">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={onToggle}
        className="flex w-full items-center gap-2 bg-neutral-50/70 px-3 py-2 text-left transition hover:bg-neutral-100/70"
      >
        <ChevronRight
          className={cn(
            'size-4 shrink-0 text-neutral-400 transition-transform',
            !collapsed && 'rotate-90',
          )}
        />
        <span className="text-sm font-semibold text-neutral-800">
          {provider.label}
        </span>
        {selectedCount > 0 ? (
          <span className="rounded-full bg-neutral-900 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white">
            {selectedCount} selected
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-2 text-xs text-neutral-400">
          {provider.note ? (
            <span className="hidden truncate sm:inline">{provider.note}</span>
          ) : null}
          <span className="tabular-nums">
            {modelCount} model{modelCount === 1 ? '' : 's'}
          </span>
        </span>
      </button>
      {collapsed ? null : <div>{children}</div>}
    </div>
  )
}

function ModelRow({
  model,
  choice,
  onToggle,
  onBestOfN,
}: {
  model: ModelOption
  choice: ModelChoice
  onToggle: () => void
  onBestOfN: (n: number) => void
}) {
  const { bestOfN } = choice
  const selected = bestOfN >= 1
  const brand = inferModelBrand(`${model.id} ${model.label}`)
  return (
    <div
      className={cn(
        'grid grid-cols-[auto_1fr_auto_auto_auto] items-center gap-4 border-b border-neutral-100 px-4 py-2.5 last:border-b-0',
        selected ? 'bg-neutral-50' : 'hover:bg-neutral-50/60',
      )}
    >
      <button
        type="button"
        role="switch"
        aria-checked={selected}
        aria-label={`Test on ${model.label}`}
        onClick={onToggle}
        className={cn(
          'flex size-5 items-center justify-center rounded border transition-colors',
          selected
            ? 'border-neutral-900 bg-neutral-900 text-white'
            : 'border-neutral-300 text-transparent hover:border-neutral-400',
        )}
      >
        <Check className="size-3.5" />
      </button>

      <div className="flex min-w-0 items-center gap-2">
        <BrandMark brand={brand} fallback={model.label} />
        <span className="truncate text-sm font-medium text-neutral-800">
          {model.label}
        </span>
      </div>

      <span className="text-right text-xs tabular-nums text-neutral-500">
        {model.costPerMTok == null ? (
          <span className="text-neutral-300">—</span>
        ) : (
          <>
            ${model.costPerMTok.toFixed(2)}
            <span className="text-neutral-400">/M</span>
          </>
        )}
      </span>

      <span className="text-right text-xs tabular-nums text-neutral-500">
        {model.tokensPerSec == null ? (
          <span className="text-neutral-300">—</span>
        ) : (
          <>
            {model.tokensPerSec}
            <span className="text-neutral-400"> tok/s</span>
          </>
        )}
      </span>

      <Stepper value={bestOfN} onChange={onBestOfN} />
    </div>
  )
}

function Stepper({
  value,
  onChange,
}: {
  value: number
  onChange: (n: number) => void
}) {
  // Always editable — the stepper drives selection. 0 = unselected, so dim it
  // there while keeping the controls live.
  return (
    <div
      className={cn(
        'flex items-center justify-self-end rounded-md border border-neutral-300',
        value === 0 && 'opacity-50',
      )}
    >
      <button
        type="button"
        aria-label="Decrease attempts"
        disabled={value <= 0}
        onClick={() => onChange(value - 1)}
        className="flex size-6 items-center justify-center text-neutral-500 transition hover:text-neutral-900 disabled:pointer-events-none disabled:opacity-40"
      >
        <Minus className="size-3" />
      </button>
      <span className="w-6 text-center text-xs font-medium tabular-nums text-neutral-800">
        {value}
      </span>
      <button
        type="button"
        aria-label="Increase attempts"
        onClick={() => onChange(value + 1)}
        className="flex size-6 items-center justify-center text-neutral-500 transition hover:text-neutral-900"
      >
        <Plus className="size-3" />
      </button>
    </div>
  )
}
