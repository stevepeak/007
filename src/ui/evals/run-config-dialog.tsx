import {
  Check,
  ChevronDown,
  ChevronRight,
  Minus,
  Play,
  Plus,
  ShieldCheck,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { ModelOption, ModelProvider } from '../../engine/config'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import { useModels, useProviders, useRunEval } from '../hooks'
import { useWfNav } from '../nav'
import { BrandMark, inferModelBrand } from './shared'

// The "Run" confirm, shared by the catalog / Goal / Sample / Test Run buttons.
// A run always executes in SIMULATION (write tools no-op, read tools return the
// row's fixtures) and is marked `is_eval` so it stays out of the Runs explorer.
//
// Before launching, the user picks which models to run against — a provider-
// bucketed matrix (each provider group collapsible) with a run-count per model
// and the model's speed on the far right. The count is the number of times each
// sample runs on that model; clicking the checkbox takes it 0 → 1, the +/-
// stepper takes it 1 → N, and stepping back to 0 unchecks the row. Selecting
// several models (or a count > 1) is the best-of-N comparison — determining
// which model performs best at the right cost/speed.
//
// The engine can't yet fan a run out across models (`startEvalRun` runs each
// sample once on the target's own configured model), so a multi-model selection
// disables the launch button with a note; single-model runs go through the
// existing path. Wiring the fan-out is the follow-up.
const SUPPORTS_MULTI_MODEL = false

export type RunConfigDialogProps = {
  open: boolean
  onClose: () => void
  /** What this run targets, for the subtitle copy. */
  scope: 'goal' | 'sample' | 'test'
  /** Display name of the thing being run (shown in the subtitle). */
  targetName: string
  /** The eval set(s) to run. Empty = nothing to launch (button disabled). */
  setIds: string[]
}

/** Bucket models under the provider the host declared for them, in declared
 * order. Orphans (no matching provider) fall into a synthetic trailing group so
 * nothing is silently hidden — same rule the model picker uses. */
function groupModelsByProvider(
  models: ModelOption[],
  providers: ModelProvider[],
): { provider: ModelProvider; models: ModelOption[] }[] {
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
}

export function RunConfigDialog({
  open,
  onClose,
  scope,
  targetName,
  setIds,
}: RunConfigDialogProps) {
  const { Button } = useWfComponents()
  const { navigate } = useWfNav()
  const runEval = useRunEval()

  const modelsQuery = useModels()
  const providersQuery = useProviders()
  const loadingModels = modelsQuery.isLoading || providersQuery.isLoading

  const models = useMemo(() => modelsQuery.data ?? [], [modelsQuery.data])
  const groups = useMemo(
    () => groupModelsByProvider(models, providersQuery.data ?? []),
    [models, providersQuery.data],
  )

  // modelId → run count (0 = unselected). One shared map across all groups.
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  // Reset the selection each time the dialog opens so a stale pick from a prior
  // target doesn't leak in.
  useEffect(() => {
    if (open) {
      setCounts({})
      setCollapsed({})
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const setCount = (modelId: string, next: number) =>
    setCounts((prev) => {
      const value = Math.max(0, next)
      if (value === 0) {
        const { [modelId]: _drop, ...rest } = prev
        return rest
      }
      return { ...prev, [modelId]: value }
    })

  const selectedIds = Object.keys(counts).filter((id) => (counts[id] ?? 0) > 0)
  const totalRuns = selectedIds.reduce((sum, id) => sum + (counts[id] ?? 0), 0)
  const needsMultiModel = selectedIds.length > 1 || totalRuns > selectedIds.length
  const multiModelBlocked = needsMultiModel && !SUPPORTS_MULTI_MODEL

  const canRun =
    setIds.length > 0 &&
    selectedIds.length > 0 &&
    !multiModelBlocked &&
    !runEval.isPending

  const launch = async () => {
    if (!canRun) return
    // TODO: thread `selectedIds` / per-model counts through once the engine can
    // fan a run out across models. Today the run uses the target's own model.
    const { evalRunId } = await runEval.mutateAsync({ setIds })
    onClose()
    navigate(`evals/runs/${evalRunId}`)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg border border-neutral-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-neutral-200 px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold text-neutral-900">Run tests</h2>
            <p className="mt-0.5 text-xs text-neutral-500">
              Run this {scope} in simulation ·{' '}
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

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Models to run against
              </h3>
              {selectedIds.length > 0 ? (
                <span className="text-xs tabular-nums text-neutral-400">
                  {selectedIds.length} model{selectedIds.length === 1 ? '' : 's'}{' '}
                  · {totalRuns} run{totalRuns === 1 ? '' : 's'} / sample
                </span>
              ) : null}
            </div>
            <div className="overflow-hidden rounded-lg border border-neutral-200">
              {loadingModels ? (
                <div className="px-3 py-8 text-center text-sm text-neutral-400">
                  Loading models…
                </div>
              ) : groups.length === 0 ? (
                <div className="px-3 py-8 text-center text-sm text-neutral-500">
                  No models available. Wire a provider into the host config.
                </div>
              ) : (
                groups.map(({ provider, models: groupModels }) => {
                  const isCollapsed = collapsed[provider.id] ?? false
                  const groupSelected = groupModels.filter(
                    (m) => (counts[m.id] ?? 0) > 0,
                  ).length
                  return (
                    <div
                      key={provider.id}
                      className="border-b border-neutral-100 last:border-b-0"
                    >
                      <button
                        type="button"
                        onClick={() =>
                          setCollapsed((prev) => ({
                            ...prev,
                            [provider.id]: !isCollapsed,
                          }))
                        }
                        className="flex w-full items-center gap-1.5 bg-neutral-50 px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-neutral-500 transition hover:text-neutral-800"
                      >
                        {isCollapsed ? (
                          <ChevronRight className="size-3.5" />
                        ) : (
                          <ChevronDown className="size-3.5" />
                        )}
                        <span className="flex-1">{provider.label}</span>
                        {groupSelected > 0 ? (
                          <span className="rounded-full bg-neutral-900 px-1.5 py-0.5 text-[10px] text-white">
                            {groupSelected}
                          </span>
                        ) : null}
                      </button>
                      {isCollapsed
                        ? null
                        : groupModels.map((m) => (
                            <ModelMatrixRow
                              key={m.id}
                              model={m}
                              count={counts[m.id] ?? 0}
                              onChange={(n) => setCount(m.id, n)}
                            />
                          ))}
                    </div>
                  )
                })
              )}
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-lg bg-neutral-50 px-3 py-2.5 text-sm text-neutral-600">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
            <p>
              Every sample runs with <strong>simulation on</strong> — write tools
              (e.g. send email) no-op and read tools return the sample&apos;s
              fixtures, so no real data is touched. The run is graded against each
              sample&apos;s tests.
            </p>
          </div>

          {setIds.length === 0 ? (
            <p className="text-xs text-amber-600">
              Nothing to run yet — add a sample first.
            </p>
          ) : null}
          {multiModelBlocked ? (
            <p className="text-xs text-amber-600">
              Running more than one model per batch isn&apos;t supported yet —
              select a single model with one run to launch. Multi-model
              comparison is coming.
            </p>
          ) : null}
          {runEval.isError ? (
            <p className="text-xs text-red-600">
              Couldn&apos;t launch the run. Check that eval runs are configured
              for this host, then try again.
            </p>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-neutral-200 px-5 py-3">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canRun} onClick={() => void launch()}>
            <Play className="size-4" />
            {runEval.isPending ? 'Launching…' : 'Start tests'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function ModelMatrixRow({
  model,
  count,
  onChange,
}: {
  model: ModelOption
  count: number
  onChange: (next: number) => void
}) {
  const brand = inferModelBrand(`${model.id} ${model.label}`)
  const selected = count > 0
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 text-sm transition',
        selected ? 'bg-neutral-50/80' : 'hover:bg-neutral-50',
      )}
    >
      {/* Checkbox — mirrors the count (0 = unchecked); toggles 0↔1. */}
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        aria-label={`Run ${model.label}`}
        onClick={() => onChange(selected ? 0 : 1)}
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded border transition',
          selected
            ? 'border-neutral-900 bg-neutral-900 text-white'
            : 'border-neutral-300 hover:border-neutral-500',
        )}
      >
        {selected ? <Check className="size-3.5" /> : null}
      </button>

      {/* icon + name */}
      <BrandMark brand={brand} fallback={model.label} />
      <span className="min-w-0 flex-1 truncate font-medium text-neutral-800">
        {model.label}
      </span>

      {/* cost */}
      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-neutral-400">
        {model.costPerMTok != null ? (
          <>
            ${model.costPerMTok.toFixed(2)}
            <span className="text-neutral-300">/M</span>
          </>
        ) : (
          <span className="text-neutral-300">—</span>
        )}
      </span>

      {/* speed */}
      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-neutral-400">
        {model.tokensPerSec != null ? (
          <>
            {model.tokensPerSec}
            <span className="text-neutral-300"> tok/s</span>
          </>
        ) : (
          <span className="text-neutral-300">—</span>
        )}
      </span>

      {/* -/+ stepper (default 0) */}
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          aria-label="One fewer run"
          disabled={count === 0}
          onClick={() => onChange(count - 1)}
          className="flex size-5 items-center justify-center rounded text-neutral-500 transition hover:bg-neutral-200 hover:text-neutral-800 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <Minus className="size-3" />
        </button>
        <span className="min-w-4 text-center text-xs font-medium tabular-nums text-neutral-800">
          {count}
        </span>
        <button
          type="button"
          aria-label="One more run"
          onClick={() => onChange(count + 1)}
          className="flex size-5 items-center justify-center rounded text-neutral-500 transition hover:bg-neutral-200 hover:text-neutral-800"
        >
          <Plus className="size-3" />
        </button>
      </div>
    </div>
  )
}
