import { AlertTriangle, Check, ChevronDown, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  ModelCapabilities,
  ModelOption,
  ModelProvider,
} from '../../engine/config'
import { cn } from '../cn'
import { BrandMark, CapabilityBadges, inferModelBrand } from '../evals/shared'
import { useModels, useProviders } from '../hooks'

// Short "why this model is unavailable" reason per required capability.
const REQUIREMENT_REASON: Record<keyof ModelCapabilities, string> = {
  tools: 'no tool calling',
  structuredOutput: 'no structured output',
  reasoning: 'no reasoning',
  vision: 'no vision',
}

/**
 * Which required capabilities a model is missing. A model with NO capability
 * info at all (e.g. the pre-refresh static fallback list) is treated as unknown
 * and never gated — we only disable a model we KNOW lacks a requirement.
 */
function unmetRequirements(
  model: ModelOption,
  requirements: ModelCapabilities | undefined,
): (keyof ModelCapabilities)[] {
  if (!requirements || !model.capabilities) return []
  return (Object.keys(requirements) as (keyof ModelCapabilities)[]).filter(
    (k) => requirements[k] && !model.capabilities?.[k],
  )
}

// A single-select model picker that mirrors the Evals "Run configuration"
// dialog: models come from the host config (config.listModels /
// config.listProviders), bucketed under their provider, each row showing the
// vendor's real SVG logomark plus cost / speed. Unlike the evals dialog (a
// multi-select best-of-N table) this picks exactly one model — for an agent's
// or node's Model field — via a compact dropdown.

/** Bucket models under the provider the host declared for them, in declared
 * order. Orphans (no matching provider) fall into a synthetic trailing group so
 * nothing is silently hidden — same rule the run-config dialog uses. */
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

export function ModelSelect({
  value,
  onChange,
  className,
  requirements,
}: {
  /** Currently selected model id. */
  value: string
  onChange: (modelId: string) => void
  className?: string
  /**
   * Capabilities the picked model must support (e.g. `{ tools: true }` when the
   * agent has tools attached). Models known to lack a requirement are shown but
   * disabled with a reason; models with unknown capabilities are left selectable.
   */
  requirements?: ModelCapabilities
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const modelsQuery = useModels()
  const providersQuery = useProviders()
  const loading = modelsQuery.isLoading || providersQuery.isLoading

  const models = useMemo(() => modelsQuery.data ?? [], [modelsQuery.data])
  const groups = useMemo(
    () => groupModelsByProvider(models, providersQuery.data ?? []),
    [models, providersQuery.data],
  )
  const selected = models.find((m) => m.id === value)
  // Warn when the CURRENT selection is known-incompatible (e.g. a tool was added
  // after the model was picked). The list still lets them switch.
  const selectedUnmet = selected
    ? unmetRequirements(selected, requirements)
    : []

  // Close on outside-click or Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const brand = selected
    ? inferModelBrand(`${selected.id} ${selected.label}`)
    : inferModelBrand(value)

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 w-full items-center gap-2 rounded-md border border-neutral-300 bg-transparent px-2 text-sm outline-none transition focus:border-neutral-500"
      >
        <BrandMark brand={brand} fallback={selected?.label ?? value} />
        <span className="min-w-0 flex-1 truncate text-left text-neutral-800">
          {selected?.label ?? value ?? 'Select a model'}
        </span>
        <ChevronDown className="size-4 shrink-0 text-neutral-400" />
      </button>

      {/* Selected model's cost + speed, so the Model field surfaces them
          without opening the dropdown. Each is shown only when reported. */}
      {selected != null &&
      (selected.costPerMTok != null || selected.tokensPerSec != null) ? (
        <div className="mt-1 flex items-center gap-3 px-1 text-xs tabular-nums text-neutral-400">
          {selected.costPerMTok != null ? (
            <span>
              ${selected.costPerMTok.toFixed(2)}
              <span className="text-neutral-300">/M</span>
            </span>
          ) : null}
          {selected.tokensPerSec != null ? (
            <span>
              {Math.round(selected.tokensPerSec)}
              <span className="text-neutral-300"> tok/s</span>
            </span>
          ) : null}
        </div>
      ) : null}

      {selectedUnmet.length > 0 ? (
        <div className="mt-1 flex items-center gap-1 text-xs text-amber-600">
          <AlertTriangle className="size-3 shrink-0" />
          <span>
            This model has {selectedUnmet.map((k) => REQUIREMENT_REASON[k]).join(', ')}
            {' '}— pick one that meets the agent's needs.
          </span>
        </div>
      ) : null}

      {open ? (
        <div className="absolute z-50 mt-1 max-h-80 w-full overflow-y-auto rounded-md border border-neutral-200 bg-white py-1 shadow-lg">
          {loading ? (
            <div className="px-3 py-6 text-center text-sm text-neutral-400">
              Loading models…
            </div>
          ) : groups.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-neutral-500">
              No models available. Wire a provider into the host config.
            </div>
          ) : (
            groups.map(({ provider, models: groupModels }) => (
              <div key={provider.id} className="mb-1 last:mb-0">
                <div className="flex items-center gap-1 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                  <ChevronRight className="size-3" />
                  {provider.label}
                </div>
                {groupModels.map((m) => {
                  const unmet = unmetRequirements(m, requirements)
                  return (
                    <ModelOptionRow
                      key={m.id}
                      model={m}
                      selected={m.id === value}
                      disabledReason={
                        unmet.length > 0
                          ? unmet.map((k) => REQUIREMENT_REASON[k]).join(', ')
                          : undefined
                      }
                      onSelect={() => {
                        onChange(m.id)
                        setOpen(false)
                      }}
                    />
                  )
                })}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}

function ModelOptionRow({
  model,
  selected,
  onSelect,
  disabledReason,
}: {
  model: ModelOption
  selected: boolean
  onSelect: () => void
  /** When set, the model doesn't meet the agent's needs: shown greyed + reason. */
  disabledReason?: string
}) {
  const brand = inferModelBrand(`${model.id} ${model.label}`)
  const disabled = disabledReason != null
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-disabled={disabled}
      disabled={disabled}
      onClick={onSelect}
      title={disabledReason}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition',
        disabled
          ? 'cursor-not-allowed opacity-50'
          : selected
            ? 'bg-neutral-100'
            : 'hover:bg-neutral-50',
      )}
    >
      <BrandMark brand={brand} fallback={model.label} />
      <span className="min-w-0 flex-1 truncate font-medium text-neutral-800">
        {model.label}
      </span>
      <CapabilityBadges capabilities={model.capabilities} />
      {disabled ? (
        <span className="shrink-0 text-xs text-amber-600">{disabledReason}</span>
      ) : (
        <>
          {model.costPerMTok != null ? (
            <span className="shrink-0 text-xs tabular-nums text-neutral-400">
              ${model.costPerMTok.toFixed(2)}
              <span className="text-neutral-300">/M</span>
            </span>
          ) : null}
          {model.tokensPerSec != null ? (
            <span className="shrink-0 text-xs tabular-nums text-neutral-400">
              {model.tokensPerSec}
              <span className="text-neutral-300"> tok/s</span>
            </span>
          ) : null}
        </>
      )}
      <Check
        className={cn(
          'size-4 shrink-0 text-neutral-900',
          selected && !disabled ? 'opacity-100' : 'opacity-0',
        )}
      />
    </button>
  )
}
