import { Check, Minus, Plus } from 'lucide-react'

import type { ModelOption } from '../../engine/config'
import { cn } from '../cn'

import { BrandMark, inferModelBrand } from './shared'

export function ModelMatrixRow({
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
        'flex items-stretch pr-3 text-sm transition',
        selected ? 'bg-neutral-50/80' : 'hover:bg-neutral-50',
      )}
    >
      {/* The row highlights on hover, so the row *is* the toggle: everything up
          to the stepper is one checkbox button. Toggles 0↔1; the square below
          is presentational (the role/state live on the button). */}
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        aria-label={`Run ${model.label}`}
        onClick={() => onChange(selected ? 0 : 1)}
        className="group/row flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-3 text-left"
      >
        <span
          className={cn(
            'flex size-5 shrink-0 items-center justify-center rounded border transition',
            selected
              ? 'border-neutral-900 bg-neutral-900 text-white'
              : 'border-neutral-300 group-hover/row:border-neutral-500',
          )}
        >
          {selected ? <Check className="size-3.5" /> : null}
        </span>

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
      </button>

      {/* -/+ stepper (default 0) */}
      <div className="flex shrink-0 items-center gap-0.5 pl-2">
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
