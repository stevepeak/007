import { ChevronDown } from 'lucide-react'
import { type ReactNode, useRef, useState } from 'react'

import { cn } from './cn'
import { useDismiss } from './use-dismiss'

// A generic single-select popover. A native <select> can only render text, so
// across 007 every richer picker (agent, tool, workflow, model, …) hand-rolled
// the same trigger-button + `role="listbox"` popover + outside-dismiss skeleton,
// and their keyboard/a11y behaviour drifted apart. This owns that skeleton once;
// callers supply only what actually differs: how to key an option, the trigger
// content, the option-row content, and the empty message. Dismiss-on-outside-
// click / Escape comes free from `useDismiss`.
//
// Styled with the semantic theme tokens (`bg-popover`, `border-input`,
// `bg-accent`, `text-muted-foreground`, …) so every select re-themes with the
// host — this one component is the shared surface for all the pickers built on it.

export function RichSelect<T>({
  options,
  value,
  onChange,
  getKey,
  isOptionDisabled,
  renderValue,
  renderOption,
  placeholder = 'Select…',
  empty,
  disabled,
  className,
  triggerClassName = 'w-full',
  listClassName = 'w-full',
  triggerLeading,
  trailing,
}: {
  options: T[]
  /** Selected key, or null/undefined when nothing is chosen. */
  value: string | null | undefined
  onChange: (option: T) => void
  /** Stable identity for an option; compared against `value` and used as the React key. */
  getKey: (option: T) => string
  /** When it returns true the row renders greyed and can't be chosen. */
  isOptionDisabled?: (option: T) => boolean
  /** Inner content of the trigger for the currently selected option. */
  renderValue: (selected: T) => ReactNode
  /** Inner content of each option row (the `role="option"` button wraps it). */
  renderOption: (option: T, selected: boolean) => ReactNode
  /** Trigger text shown when nothing is selected. */
  placeholder?: ReactNode
  /** Shown inside the open list when `options` is empty. A string is styled; a node is rendered as-is. */
  empty?: ReactNode
  disabled?: boolean
  /** Class for the relative container (override for e.g. a flex row with a sibling control). */
  className?: string
  /** Trigger width/layout; defaults to `w-full`. Override for a flex row (e.g. `min-w-0 flex-1`). */
  triggerClassName?: string
  /** Popover width/position; defaults to `w-full`. Override for e.g. `left-0 right-0 top-full`. */
  listClassName?: string
  /** Fixed leading node in the trigger, shown even with no selection (e.g. a category icon). */
  triggerLeading?: ReactNode
  /** Sibling control rendered next to the trigger inside the container (e.g. a version stepper). */
  trailing?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useDismiss(ref, open, () => setOpen(false))

  const selected = options.find((o) => getKey(o) === value)

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex h-9 items-center gap-2 rounded-md border border-input bg-transparent px-2 text-left text-sm outline-none focus:border-neutral-500 disabled:opacity-50',
          triggerClassName,
        )}
      >
        {triggerLeading}
        {selected ? (
          renderValue(selected)
        ) : (
          <span className="text-muted-foreground flex-1">{placeholder}</span>
        )}
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </button>

      {trailing}

      {open ? (
        <div
          role="listbox"
          className={cn(
            'absolute z-50 mt-1 max-h-72 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg',
            listClassName,
          )}
        >
          {options.length === 0 && empty != null ? (
            typeof empty === 'string' ? (
              <div className="p-2 text-xs text-muted-foreground">{empty}</div>
            ) : (
              empty
            )
          ) : null}
          {options.map((opt) => {
            const key = getKey(opt)
            const isSelected = key === value
            const optDisabled = isOptionDisabled?.(opt) ?? false
            return (
              <button
                key={key}
                type="button"
                role="option"
                aria-selected={isSelected}
                aria-disabled={optDisabled}
                disabled={optDisabled}
                onClick={() => {
                  onChange(opt)
                  setOpen(false)
                }}
                className={cn(
                  'flex w-full items-start gap-2 rounded-md p-2 text-left transition hover:bg-accent',
                  isSelected && 'bg-accent',
                  optDisabled && 'cursor-not-allowed opacity-50',
                )}
              >
                {renderOption(opt, isSelected)}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
