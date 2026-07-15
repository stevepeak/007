import { type LucideIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { cn } from '../cn'

// A top-to-bottom flow of full-width cards — one per step of "choose something →
// configure the next thing". Every card is always open: the header names the step
// (with an optional right-aligned accessory — a planned-⚡ marker, meta label, or
// action), and the body holds that step's editor.

export type Step = {
  key: string
  /** Card header label. */
  title: string
  /** Right-aligned header accessory. */
  aside?: ReactNode
  content: ReactNode
}

export function StepFlow({ steps }: { steps: Step[] }) {
  return (
    <div className="space-y-3">
      {steps.map((s) => (
        <section
          key={s.key}
          className="overflow-hidden rounded-lg border border-neutral-200"
        >
          <div className="flex items-center gap-1 border-b border-neutral-100 bg-neutral-50 px-4 py-2">
            <span className="text-sm font-medium text-neutral-700">
              {s.title}
            </span>
            {s.aside ? (
              <div className="ml-auto flex items-center gap-2">{s.aside}</div>
            ) : null}
          </div>
          <div className="p-4">{s.content}</div>
        </section>
      ))}
    </div>
  )
}

// ── Picker cards ─────────────────────────────────────────────────────────────
// A choice between a few big tiles (icon + label + blurb + its own setting). Once
// you pick one and hit Done, the picker collapses to a compact chip showing just
// the chosen option; "Change" re-opens the tiles.

type Accent = 'violet' | 'indigo' | 'sky' | 'amber'

const ACCENTS: Record<Accent, { card: string; icon: string }> = {
  violet: { card: 'border-violet-400 bg-violet-50/60', icon: 'bg-violet-100 text-violet-700' },
  indigo: { card: 'border-indigo-400 bg-indigo-50/60', icon: 'bg-indigo-100 text-indigo-700' },
  sky: { card: 'border-sky-400 bg-sky-50/60', icon: 'bg-sky-100 text-sky-700' },
  amber: { card: 'border-amber-400 bg-amber-50/60', icon: 'bg-amber-100 text-amber-700' },
}

type PickerOption<T extends string> = {
  value: T
  icon: LucideIcon
  label: string
  desc: string
  accent: Accent
  disabled?: boolean
  /** Corner badge (e.g. "Coming soon") for a disabled tile. */
  badge?: string
  /** Setting editor shown inside the tile while it is the selected option. */
  setting?: ReactNode
  /** Compact detail shown beside the label when collapsed. */
  detail?: ReactNode
}

export function PickerCards<T extends string>({
  value,
  options,
  onSelect,
  collapsedByDefault,
}: {
  value: T
  options: PickerOption<T>[]
  onSelect: (value: T) => void
  collapsedByDefault?: boolean
}) {
  const [editing, setEditing] = useState(!collapsedByDefault)
  const selected = options.find((o) => o.value === value)

  if (!editing && selected) {
    const a = ACCENTS[selected.accent]
    const Icon = selected.icon
    return (
      <div className="flex items-center gap-3 rounded-xl border border-neutral-200 p-3">
        <span
          className={cn(
            'flex size-10 items-center justify-center rounded-lg',
            a.icon,
          )}
        >
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-neutral-900">
            {selected.label}
          </div>
          {selected.detail ? (
            <div className="truncate text-xs text-neutral-500">
              {selected.detail}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-xs font-medium text-neutral-500 hover:text-neutral-800"
        >
          Change
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        {options.map((o) => {
          const Icon = o.icon
          const on = o.value === value
          const a = ACCENTS[o.accent]
          return (
            <div
              key={o.value}
              className={cn(
                'rounded-xl border-2 p-5 text-center',
                o.disabled
                  ? 'border-dashed border-neutral-200 bg-neutral-50'
                  : on
                    ? a.card
                    : 'border-neutral-200 bg-white',
              )}
            >
              <button
                type="button"
                disabled={o.disabled}
                onClick={() => onSelect(o.value)}
                className="flex w-full flex-col items-center gap-3 disabled:cursor-not-allowed"
              >
                <span
                  className={cn(
                    'flex size-14 items-center justify-center rounded-xl',
                    o.disabled
                      ? 'bg-neutral-100 text-neutral-300'
                      : on
                        ? a.icon
                        : 'bg-neutral-100 text-neutral-500',
                  )}
                >
                  <Icon className="size-7" />
                </span>
                <div>
                  <div
                    className={cn(
                      'text-lg font-semibold',
                      o.disabled ? 'text-neutral-400' : 'text-neutral-900',
                    )}
                  >
                    {o.label}
                  </div>
                  <p
                    className={cn(
                      'mt-0.5 text-sm',
                      o.disabled ? 'text-neutral-400' : 'text-neutral-500',
                    )}
                  >
                    {o.desc}
                  </p>
                </div>
                {o.badge ? (
                  <span className="rounded-full bg-neutral-200 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                    {o.badge}
                  </span>
                ) : null}
              </button>
              {on && !o.disabled && o.setting ? (
                <div className="mt-4 text-left">{o.setting}</div>
              ) : null}
            </div>
          )
        })}
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700"
        >
          Done
        </button>
      </div>
    </div>
  )
}
