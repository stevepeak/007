import { Check, type LucideIcon } from 'lucide-react'
import { Fragment, type ReactNode, useState } from 'react'

import { cn } from './cn'
import { Popover } from './popover'
import { Tooltip } from './tooltip'

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

export type SegmentedOption<T extends string> = {
  value: T
  label: string
  icon?: LucideIcon
  /** Tooltip; with the `icon` variant it is the only visible description. */
  hint?: string
  /** Overrides the variant's active colors for this one option. */
  activeClass?: string
}

type SegmentedVariant = 'rail' | 'fill' | 'chip' | 'icon' | 'joined'

// One look per call-site family. Each is a full class set rather than a
// modifier because `cn` is clsx only: a later class cannot override an earlier
// one, so sizes and colors must be chosen here, never appended.
const SEGMENTED_STYLES: Record<
  SegmentedVariant,
  {
    track: string
    button: string
    active: string
    idle: string
    /** Hover for an idle option; dropped while disabled. */
    hover: string
    icon: string
  }
> = {
  /** Neutral gray rail, the active option lifted. Toolbar tabs. */
  rail: {
    track: 'inline-flex items-center rounded-md bg-neutral-100 p-0.5',
    button: 'rounded px-2.5 py-1 text-xs font-medium transition-colors',
    active: 'bg-white text-neutral-900 shadow-sm',
    idle: 'text-neutral-500',
    hover: 'hover:text-neutral-900',
    icon: 'size-3.5',
  },
  /** The rail on semantic tokens, stretched to fill its row. Inspector fields. */
  fill: {
    track: 'bg-muted inline-flex w-full gap-0.5 rounded-md p-0.5',
    button:
      'flex flex-1 items-center justify-center gap-1.5 rounded-[5px] px-2.5 py-1.5 text-xs font-medium transition-colors',
    active: 'bg-background text-foreground shadow-sm',
    idle: 'text-muted-foreground',
    hover: 'hover:text-foreground',
    icon: 'size-3.5',
  },
  /** Small outlined chips, each option tinted by its `activeClass`. */
  chip: {
    track:
      'flex shrink-0 items-center gap-0.5 rounded-md border border-neutral-200 bg-white p-0.5',
    button:
      'flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition',
    active: 'bg-neutral-100 text-neutral-900',
    idle: 'text-neutral-400',
    hover: 'hover:bg-neutral-100 hover:text-neutral-600',
    icon: 'size-3',
  },
  /** `chip` as square icon-only buttons; the label becomes the aria-label. */
  icon: {
    track:
      'flex shrink-0 items-center gap-0.5 rounded-md border border-neutral-200 bg-white p-0.5',
    button: 'flex size-6 items-center justify-center rounded transition',
    active: 'bg-neutral-100 text-neutral-900',
    idle: 'text-neutral-300',
    hover: 'hover:bg-neutral-100 hover:text-neutral-500',
    icon: 'size-3.5',
  },
  /** Flush buttons sharing one bordered box. */
  joined: {
    track: 'inline-flex overflow-hidden rounded-md border border-neutral-300',
    button: 'px-2 py-1',
    active: 'bg-amber-100 text-amber-700',
    idle: '',
    hover: 'hover:bg-neutral-100',
    icon: 'size-3',
  },
}

/** A segmented button track — mutually-exclusive options, one pressed. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  variant = 'rail',
  disabled,
}: {
  label: string
  options: SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  variant?: SegmentedVariant
  disabled?: boolean
}) {
  const style = SEGMENTED_STYLES[variant]
  const iconOnly = variant === 'icon'
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(style.track, disabled && 'cursor-not-allowed opacity-60')}
    >
      {options.map((opt) => {
        const active = opt.value === value
        const Icon = opt.icon
        return (
          <Tooltip key={opt.value} content={opt.hint} side="bottom">
            <button
              type="button"
              aria-label={iconOnly ? opt.label : undefined}
              aria-pressed={active}
              disabled={disabled}
              onClick={() => onChange(opt.value)}
              className={cn(
                style.button,
                active ? (opt.activeClass ?? style.active) : style.idle,
                !disabled && !active && style.hover,
                disabled && 'cursor-not-allowed',
              )}
            >
              {Icon ? <Icon className={style.icon} /> : null}
              {iconOnly ? null : opt.label}
            </button>
          </Tooltip>
        )
      })}
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
   * Rich rendering for the option — a coloured dot, an icon + name, an avatar.
   * Used in place of the bare label on BOTH the option row and the trigger badge,
   * so a picked option looks the same open or closed. `label` still drives search
   * and the a11y name, so always give a real one.
   */
  node?: ReactNode
  /** The `node` already renders its own badge, so the trigger skips the wrapper. */
  selfBadged?: boolean
  /** Draws a divider line above this option in the panel. */
  separatorBefore?: boolean
}

/** A chosen option as it reads on a pill trigger: always in a badge. */
function PickedBadge({ option }: { option: FilterPillOption }) {
  const content = option.node ?? option.label
  if (option.selfBadged) return <>{content}</>
  return (
    <span className="inline-flex max-w-56 items-center rounded-sm bg-accent px-1.5 py-0.5 text-xs font-normal">
      <span className="truncate">{content}</span>
    </span>
  )
}

type PillProps = {
  label: string
  options: FilterPillOption[]
  align?: 'start' | 'end'
  /** Forces the in-panel search box on; it auto-appears past 8 options. */
  searchPlaceholder?: string
  className?: string
}

/**
 * The toolbar filter affordance: a pill trigger with a popover option list.
 * Unset it renders dashed + muted (`[Type]`); set it renders solid with each
 * chosen option as a badge (`[Type | Tools]`). The panel is just the options —
 * no title — with a small centered "Clear" at the foot once something is set.
 * `FilterPill` is single-select; `FilterPillMulti` toggles any number of rows.
 */
function PillBase({
  label,
  options,
  align = 'start',
  searchPlaceholder,
  className,
  values,
  multiple,
  onChange,
}: PillProps & {
  values: string[]
  multiple: boolean
  onChange: (next: string[]) => void
}) {
  const picked = options.filter((o) => values.includes(o.value))
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
            picked.length > 0
              ? 'border-input'
              : 'border-dashed border-input text-muted-foreground',
          )}
        >
          {label}
          {picked.length > 0 ? (
            <>
              <span className="mx-0.5 h-4 w-px bg-border" />
              {picked.map((o) => (
                <PickedBadge key={o.value} option={o} />
              ))}
            </>
          ) : null}
        </button>
      )}
    >
      {({ close }) => (
        <FilterPillPanel
          options={options}
          values={values}
          searchable={searchable}
          searchPlaceholder={searchPlaceholder ?? `Search ${label.toLowerCase()}…`}
          onPick={(v) => {
            if (!multiple) {
              onChange(values.includes(v) ? [] : [v])
              close()
            } else {
              onChange(
                values.includes(v)
                  ? values.filter((x) => x !== v)
                  : [...values, v],
              )
            }
          }}
          onClear={() => {
            onChange([])
            if (!multiple) close()
          }}
        />
      )}
    </Popover>
  )
}

/** Single-select pill. `value` is the chosen option's value; `''` = no filter. */
export function FilterPill({
  value,
  onChange,
  ...rest
}: PillProps & { value: string; onChange: (next: string) => void }) {
  return (
    <PillBase
      {...rest}
      multiple={false}
      values={value ? [value] : []}
      onChange={(next) => onChange(next[0] ?? '')}
    />
  )
}

/** Multi-select pill. `value` is the chosen values; `[]` = no filter. */
export function FilterPillMulti({
  value,
  onChange,
  ...rest
}: PillProps & { value: string[]; onChange: (next: string[]) => void }) {
  return (
    <PillBase {...rest} multiple values={value} onChange={onChange} />
  )
}

function FilterPillPanel({
  options,
  values,
  searchable,
  searchPlaceholder,
  onPick,
  onClear,
}: {
  options: FilterPillOption[]
  values: string[]
  searchable: boolean
  searchPlaceholder: string
  onPick: (value: string) => void
  onClear: () => void
}) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const shown = q
    ? options.filter((o) => o.label.toLowerCase().includes(q))
    : options

  return (
    <>
      {searchable ? (
        <>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            className="mb-1 h-8 w-full rounded-sm bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground"
          />
          <div className="h-px bg-border" />
        </>
      ) : null}
      {shown.length === 0 ? (
        <div className="px-2 py-3 text-xs text-muted-foreground">
          No matches.
        </div>
      ) : null}
      {shown.map((opt) => {
        const on = values.includes(opt.value)
        return (
          <Fragment key={opt.value}>
            {opt.separatorBefore ? <div className="mt-1 h-px bg-border" /> : null}
            <button
              type="button"
              role="option"
              aria-selected={on}
              onClick={() => onPick(opt.value)}
              className={cn(
                'mt-0.5 flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition hover:bg-accent',
                on && 'bg-accent',
              )}
            >
              <span className="min-w-0 flex-1 truncate">
                {opt.node ?? opt.label}
              </span>
              {on ? <Check className="size-3.5 shrink-0" /> : null}
            </button>
          </Fragment>
        )
      })}
      {values.length > 0 ? (
        <>
          <div className="mt-1 h-px bg-border" />
          <button
            type="button"
            onClick={onClear}
            className="mt-0.5 w-full rounded-sm px-2 py-1.5 text-center text-xs transition hover:bg-accent"
          >
            Clear
          </button>
        </>
      ) : null}
    </>
  )
}
