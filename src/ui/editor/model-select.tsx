import { Check, ChevronDown, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { ModelOption, ModelProvider } from '../../engine/config'
import { cn } from '../cn'
import { BrandMark, inferModelBrand } from '../evals/shared'
import { useModels, useProviders } from '../hooks'

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
}: {
  /** Currently selected model id. */
  value: string
  onChange: (modelId: string) => void
  className?: string
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
                {groupModels.map((m) => (
                  <ModelOptionRow
                    key={m.id}
                    model={m}
                    selected={m.id === value}
                    onSelect={() => {
                      onChange(m.id)
                      setOpen(false)
                    }}
                  />
                ))}
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
}: {
  model: ModelOption
  selected: boolean
  onSelect: () => void
}) {
  const brand = inferModelBrand(`${model.id} ${model.label}`)
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition',
        selected ? 'bg-neutral-100' : 'hover:bg-neutral-50',
      )}
    >
      <BrandMark brand={brand} fallback={model.label} />
      <span className="min-w-0 flex-1 truncate font-medium text-neutral-800">
        {model.label}
      </span>
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
      <Check
        className={cn(
          'size-4 shrink-0 text-neutral-900',
          selected ? 'opacity-100' : 'opacity-0',
        )}
      />
    </button>
  )
}
