import { Check, ChevronDown } from 'lucide-react'
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'

import { cn } from './cn'
import { useDismiss } from './use-dismiss'

// A generic single-select popover. A native <select> can only render text, so
// across 007 every richer picker (agent, tool, workflow, model, …) hand-rolled
// the same trigger-button + `role="listbox"` popover + outside-dismiss skeleton,
// and their keyboard/a11y behaviour drifted apart. This owns that skeleton once;
// callers supply only what actually differs: how to key and search an option, the
// trigger content, the option-row content, and the empty message. Dismiss-on-
// outside-click / Escape comes free from `useDismiss`.
//
// Search is not optional: every picker built on this filters the same way, so
// they all behave alike.
//
// Styled with the semantic theme tokens (`bg-popover`, `border-input`,
// `bg-accent`, `text-muted-foreground`, …) so every select re-themes with the
// host — this one component is the shared surface for all the pickers built on it.

/** Case-insensitive substring match; a blank query keeps every option. */
export function filterOptions<T>({
  options,
  query,
  getSearchText,
}: {
  options: T[]
  query: string
  getSearchText: (option: T) => string
}): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return options
  return options.filter((o) => getSearchText(o).toLowerCase().includes(q))
}

export function RichSelect<T>({
  options,
  value,
  onChange,
  getKey,
  getSearchText,
  isOptionDisabled,
  renderValue,
  renderOption,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
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
  /** The text a search query is matched against. */
  getSearchText: (option: T) => string
  /** When it returns true the row renders greyed and can't be chosen. */
  isOptionDisabled?: (option: T) => boolean
  /** Inner content of the trigger for the currently selected option. */
  renderValue: (selected: T) => ReactNode
  /** Inner content of each option row (the `role="option"` button wraps it). */
  renderOption: (option: T) => ReactNode
  /** Trigger text shown when nothing is selected. */
  placeholder?: ReactNode
  /** Placeholder (and accessible name) of the search box in the open list. */
  searchPlaceholder?: string
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
  const triggerRef = useRef<HTMLButtonElement>(null)

  useDismiss(ref, open, () => setOpen(false))

  const selected = options.find((o) => getKey(o) === value)

  const closeToTrigger = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <div
      ref={ref}
      className={cn('relative', className)}
      onKeyDown={(e) => {
        // Stopped here so a surrounding Modal's window-level Escape listener
        // doesn't close along with the list.
        if (open && e.key === 'Escape') {
          e.stopPropagation()
          closeToTrigger()
        }
      }}
    >
      <button
        ref={triggerRef}
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
          className={cn(
            'absolute z-50 mt-1 rounded-md border border-border bg-popover shadow-lg',
            listClassName,
          )}
        >
          <RichSelectPanel
            options={options}
            value={value}
            getKey={getKey}
            getSearchText={getSearchText}
            isOptionDisabled={isOptionDisabled}
            renderOption={renderOption}
            searchPlaceholder={searchPlaceholder}
            empty={empty}
            onPick={(option) => {
              onChange(option)
              closeToTrigger()
            }}
          />
        </div>
      ) : null}
    </div>
  )
}

// Mounted only while the list is open, so the query starts blank each time.
function RichSelectPanel<T>({
  options,
  value,
  getKey,
  getSearchText,
  isOptionDisabled,
  renderOption,
  searchPlaceholder,
  empty,
  onPick,
}: {
  options: T[]
  value: string | null | undefined
  getKey: (option: T) => string
  getSearchText: (option: T) => string
  isOptionDisabled?: (option: T) => boolean
  renderOption: (option: T) => ReactNode
  searchPlaceholder: string
  empty?: ReactNode
  onPick: (option: T) => void
}) {
  const listId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const optionId = (index: number) => `${listId}-${index}`

  const isEnabled = (option: T) => !(isOptionDisabled?.(option) ?? false)
  const firstEnabledIndex = (list: T[]) => list.findIndex(isEnabled)

  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(() => {
    const selectedIndex = options.findIndex((o) => getKey(o) === value)
    return selectedIndex === -1 ? firstEnabledIndex(options) : selectedIndex
  })
  const shown = filterOptions({ options, query, getSearchText })

  // Opens scrolled to the selected row, which may sit below the fold.
  const initialRowIdRef = useRef(optionId(activeIndex))
  useEffect(() => {
    document
      .getElementById(initialRowIdRef.current)
      ?.scrollIntoView({ block: 'nearest' })
  }, [])

  const moveActive = (step: 1 | -1) => {
    let next = activeIndex + step
    while (shown[next] !== undefined && !isEnabled(shown[next])) next += step
    if (shown[next] === undefined) return
    setActiveIndex(next)
    document.getElementById(optionId(next))?.scrollIntoView({ block: 'nearest' })
  }

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveActive(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveActive(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const active = shown[activeIndex]
      if (active !== undefined && isEnabled(active)) onPick(active)
    }
  }

  if (options.length === 0) {
    if (empty == null) return null
    return typeof empty === 'string' ? (
      <div className="p-2 text-xs text-muted-foreground">{empty}</div>
    ) : (
      <>{empty}</>
    )
  }

  return (
    <>
      <div className="border-b border-border p-1">
        <input
          autoFocus
          role="combobox"
          aria-label={searchPlaceholder}
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={
            shown[activeIndex] !== undefined ? optionId(activeIndex) : undefined
          }
          value={query}
          onChange={(e) => {
            const next = e.target.value
            setQuery(next)
            // The list may have opened scrolled to the selected row; the new
            // top match has to be in view.
            if (listRef.current) listRef.current.scrollTop = 0
            setActiveIndex(
              firstEnabledIndex(
                filterOptions({ options, query: next, getSearchText }),
              ),
            )
          }}
          onKeyDown={onSearchKeyDown}
          placeholder={searchPlaceholder}
          className="h-8 w-full rounded-sm bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        className="max-h-72 overflow-y-auto p-1"
      >
        {shown.length === 0 ? (
          <div className="p-2 text-xs text-muted-foreground">No matches.</div>
        ) : null}
        {shown.map((opt, index) => {
          const key = getKey(opt)
          const isSelected = key === value
          const optDisabled = !isEnabled(opt)
          return (
            <button
              key={key}
              id={optionId(index)}
              type="button"
              role="option"
              aria-selected={isSelected}
              aria-disabled={optDisabled}
              disabled={optDisabled}
              // Move, not enter: a row scrolling under a still cursor during
              // arrow-key navigation must not steal the highlight.
              onMouseMove={() => {
                if (!optDisabled) setActiveIndex(index)
              }}
              onClick={() => onPick(opt)}
              className={cn(
                'flex w-full items-start gap-2 rounded-md p-2 text-left transition',
                index === activeIndex && 'bg-accent',
                optDisabled && 'cursor-not-allowed opacity-50',
              )}
            >
              {renderOption(opt)}
              {isSelected ? (
                <Check className="mt-0.5 size-4 shrink-0 text-foreground" />
              ) : null}
            </button>
          )
        })}
      </div>
    </>
  )
}
