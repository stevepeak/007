import { Check } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { cn } from './cn'
import { Popover } from './popover'

// The filter / segmented-control family. Four flavours of the same "pick one
// of N labelled options" data model, kept as distinct exports because their
// affordances differ enough that one component with a variant union would be
// less legible than four small ones:
//   - `FilterSelect` — a compact native `<select>` dropdown (toolbar filters).
//   - `FilterPill`   — a dashed-until-set pill + popover list (toolbar filters
//                      that should read as removable facets rather than fields).
//   - `Segmented`     — a pill/segmented button track (mutually-exclusive tabs).
//   - `Tabs`          — an underline tab strip with optional count badges.
// Previously `FilterSelect` was copy-pasted in the models list and the eval
// results table, and `Segmented`/`Tabs` lived in separate feature files; this is
// their one home.

// ── FilterSelect ──────────────────────────────────────────────────────────────

/** A labelled native `<select>` — the compact dropdown used in filter toolbars. */
export function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-neutral-400">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs text-neutral-700 outline-none transition focus:border-neutral-400"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

// ── Segmented ─────────────────────────────────────────────────────────────────

/** A pill/segmented button track — mutually-exclusive options in a gray rail. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex items-center rounded-md bg-neutral-100 p-0.5"
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            'rounded px-2.5 py-1 text-xs font-medium transition-colors',
            value === opt.value
              ? 'bg-white text-neutral-900 shadow-sm'
              : 'text-neutral-500 hover:text-neutral-900',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

export type TabDef = { key: string; label: string; count?: number }

/** An underline tab strip with optional per-tab count badges. */
export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: TabDef[]
  active: string
  onChange: (key: string) => void
}) {
  return (
    <div className="flex items-center gap-1 border-b border-neutral-200">
      {tabs.map((t) => {
        const on = t.key === active
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            className={cn(
              '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              on
                ? 'border-neutral-900 text-neutral-900'
                : 'border-transparent text-neutral-500 hover:text-neutral-800',
            )}
          >
            {t.label}
            {t.count != null ? (
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 text-[11px] font-medium',
                  on
                    ? 'bg-neutral-900 text-white'
                    : 'bg-neutral-100 text-neutral-500',
                )}
              >
                {t.count}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

// ── FilterPill ────────────────────────────────────────────────────────────────

export type FilterPillOption = {
  value: string
  label: string
  /**
   * Rich rendering for the option — a run-status badge, a coloured dot, an
   * icon + name. Used in place of the bare label on BOTH the option row and the
   * trigger, so a picked option looks the same open or closed. `label` still
   * drives search and the a11y name, so always give a real one.
   */
  node?: ReactNode
}

/**
 * A pill filter trigger with a popover option list — the toolbar affordance the
 * host uses for its data tables (`DataTableFilter`), mirrored here so the SDK's
 * filter bars read the same. Unset it renders dashed + muted (`[Trigger]`); set
 * it renders solid with the chosen option as a badge (`[Trigger  chat]`).
 *
 * Single-select: `value` is the chosen option's value, `''` meaning "no filter".
 * Picking a row closes the panel; clicking the already-checked row unchecks it
 * (back to `''`), as does "Clear" at the foot of the panel.
 */
export function FilterPill({
  label,
  options,
  value,
  onChange,
  align = 'start',
  searchPlaceholder,
  className,
}: {
  label: string
  options: FilterPillOption[]
  /** Selected option value; `''` = unset (no filter applied). */
  value: string
  onChange: (next: string) => void
  align?: 'start' | 'end'
  /** Forces the in-panel search box on; it auto-appears past 8 options. */
  searchPlaceholder?: string
  className?: string
}) {
  const selected = options.find((o) => o.value === value)
  const searchable = searchPlaceholder != null || options.length > 8

  return (
    <Popover
      className={cn('relative', className)}
      panelClassName={cn(
        'absolute z-50 mt-1 max-h-80 w-56 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg',
        align === 'end' ? 'right-0' : 'left-0',
      )}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={toggle}
          className={cn(
            'inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium outline-none transition-colors hover:bg-accent',
            value
              ? 'border-input'
              : 'border-dashed border-input text-muted-foreground',
          )}
        >
          {label}
          {selected ? (
            <>
              <span className="mx-0.5 h-4 w-px bg-border" />
              {selected.node ?? (
                <span className="rounded-sm bg-accent px-1.5 py-0.5 text-xs font-normal">
                  {selected.label}
                </span>
              )}
            </>
          ) : null}
        </button>
      )}
    >
      {({ close }) => (
        <FilterPillPanel
          label={label}
          options={options}
          value={value}
          searchable={searchable}
          searchPlaceholder={searchPlaceholder ?? `Search ${label.toLowerCase()}…`}
          onPick={(next) => {
            onChange(next)
            close()
          }}
        />
      )}
    </Popover>
  )
}

function FilterPillPanel({
  label,
  options,
  value,
  searchable,
  searchPlaceholder,
  onPick,
}: {
  label: string
  options: FilterPillOption[]
  value: string
  searchable: boolean
  searchPlaceholder: string
  onPick: (next: string) => void
}) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const shown = q
    ? options.filter((o) => o.label.toLowerCase().includes(q))
    : options

  return (
    <>
      {searchable ? (
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={searchPlaceholder}
          className="mb-1 h-8 w-full rounded-sm bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground"
        />
      ) : (
        <div className="px-2 py-1.5 text-xs font-normal uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
      )}
      <div className="h-px bg-border" />
      {shown.length === 0 ? (
        <div className="px-2 py-3 text-xs text-muted-foreground">
          No matches.
        </div>
      ) : null}
      {shown.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="option"
          aria-selected={opt.value === value}
          // Re-picking the checked option clears the filter, so the row acts
          // as a toggle rather than a dead click.
          onClick={() => onPick(opt.value === value ? '' : opt.value)}
          className={cn(
            'mt-0.5 flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition hover:bg-accent',
            opt.value === value && 'bg-accent',
          )}
        >
          <span className="min-w-0 flex-1 truncate">
            {opt.node ?? opt.label}
          </span>
          {opt.value === value ? <Check className="size-3.5 shrink-0" /> : null}
        </button>
      ))}
      {value ? (
        <>
          <div className="mt-1 h-px bg-border" />
          <button
            type="button"
            onClick={() => onPick('')}
            className="mt-0.5 w-full rounded-sm px-2 py-1.5 text-left text-sm transition hover:bg-accent"
          >
            Clear
          </button>
        </>
      ) : null}
    </>
  )
}
