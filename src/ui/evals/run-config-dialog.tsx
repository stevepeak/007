import { Check, Minus, Plus, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { cn } from '../cn'
import { useWfComponents } from '../context'
import { MOCK_MODELS, type MockModel } from './mock-data'
import { BrandMark } from './shared'

// The "Run" configuration dialog, shared by the Goal / Sample / Test Run
// buttons. Step 1 (this screen): pick which AI models to test the target on,
// and how many best-of-N attempts each. "Next" is inert for now — the run
// launcher isn't wired yet. All mock: nothing is persisted or executed.

type ModelChoice = {
  selected: boolean
  /** Best-of-N attempts for this model (min 1). */
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

  useEffect(() => {
    if (!open) return
    setChoices({})
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const selectedCount = useMemo(
    () => Object.values(choices).filter((c) => c.selected).length,
    [choices],
  )

  if (!open) return null

  const toggle = (id: string) =>
    setChoices((prev) => {
      const cur = prev[id] ?? { selected: false, bestOfN: 1 }
      return { ...prev, [id]: { ...cur, selected: !cur.selected } }
    })

  const setBestOfN = (id: string, n: number) =>
    setChoices((prev) => {
      const cur = prev[id] ?? { selected: false, bestOfN: 1 }
      return { ...prev, [id]: { ...cur, bestOfN: Math.max(1, n) } }
    })

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
          <div className="overflow-hidden rounded-lg border border-neutral-200">
            <div className="grid grid-cols-[auto_1fr_auto_auto_auto] items-center gap-4 border-b border-neutral-100 bg-neutral-50 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
              <span>Test</span>
              <span>Model</span>
              <span className="text-right">Cost</span>
              <span className="text-right">Speed</span>
              <span className="text-right">Best of N</span>
            </div>
            {MOCK_MODELS.map((m) => (
              <ModelRow
                key={m.id}
                model={m}
                choice={choices[m.id] ?? { selected: false, bestOfN: 1 }}
                onToggle={() => toggle(m.id)}
                onBestOfN={(n) => setBestOfN(m.id, n)}
              />
            ))}
          </div>
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

function ModelRow({
  model,
  choice,
  onToggle,
  onBestOfN,
}: {
  model: MockModel
  choice: ModelChoice
  onToggle: () => void
  onBestOfN: (n: number) => void
}) {
  const { selected, bestOfN } = choice
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
        aria-label={`Test on ${model.name}`}
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
        <BrandMark brand={model.brand} />
        <span className="truncate text-sm font-medium text-neutral-800">
          {model.name}
        </span>
      </div>

      <span className="text-right text-xs tabular-nums text-neutral-500">
        ${model.costPerMTok.toFixed(2)}
        <span className="text-neutral-400">/M</span>
      </span>

      <span className="text-right text-xs tabular-nums text-neutral-500">
        {model.tokensPerSec}
        <span className="text-neutral-400"> tok/s</span>
      </span>

      <Stepper value={bestOfN} disabled={!selected} onChange={onBestOfN} />
    </div>
  )
}

function Stepper({
  value,
  disabled,
  onChange,
}: {
  value: number
  disabled: boolean
  onChange: (n: number) => void
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-self-end rounded-md border border-neutral-300',
        disabled && 'opacity-40',
      )}
    >
      <button
        type="button"
        aria-label="Decrease attempts"
        disabled={disabled || value <= 1}
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
        disabled={disabled}
        onClick={() => onChange(value + 1)}
        className="flex size-6 items-center justify-center text-neutral-500 transition hover:text-neutral-900 disabled:pointer-events-none"
      >
        <Plus className="size-3" />
      </button>
    </div>
  )
}
