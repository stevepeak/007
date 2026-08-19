import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'

import {
  AGENT_COLORS,
  AGENT_ICONS,
  ALL_AGENT_ICON_NAMES,
  ALL_AGENT_ICONS,
  agentColor,
  agentIcon,
} from './agent-appearance'
import { cn } from './cn'
import { Popover } from './popover'

// The appearance control: the asset's icon chip IS the trigger, so the thing you
// click to restyle is the thing you're restyling. It sits next to the title in
// the editor header rather than as a form section further down the page —
// appearance is identity, not configuration, and it saves immediately.
//
// The panel carries the whole palette (every tint in the shared color set) and
// the whole lucide icon set: a curated grid to open on, and search over all
// ~1750 names once you type. That subsumes the old two-step "quick picks + open
// the browse-all modal" flow.

// How many icon buttons we're willing to paint at once. A query-less open shows
// the curated grid, so this only bites on a broad search term.
const MAX_ICON_RESULTS = 120

// "FileSearch" / "AArrowDown" → "file search" / "a arrow down" for matching.
function searchable(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
}

const SEARCH_INDEX: { name: string; haystack: string }[] =
  ALL_AGENT_ICON_NAMES.map((name) => ({ name, haystack: searchable(name) }))

export type AppearancePickerProps = {
  /** Currently-stored lucide icon name. */
  icon: string
  /** Currently-stored palette color key. */
  color: string
  onSelectIcon: (name: string) => void
  onSelectColor: (key: string) => void
  /** Trigger tooltip / aria label, e.g. "Agent appearance". */
  label?: string
  className?: string
}

export function AppearancePicker({
  icon,
  color,
  onSelectIcon,
  onSelectColor,
  label = 'Appearance',
  className,
}: AppearancePickerProps) {
  const [query, setQuery] = useState('')

  const chip = agentColor(color).chip
  const TriggerIcon = agentIcon(icon)

  // No query → the curated grid, with the current icon pinned in front when it
  // isn't one of them (so the selection is always visible on open).
  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) {
      const curated = AGENT_ICONS.map((i) => i.name)
      return curated.includes(icon) ? curated : [icon, ...curated]
    }
    const terms = q.split(/\s+/)
    return SEARCH_INDEX.filter((e) =>
      terms.every((t) => e.haystack.includes(t)),
    ).map((e) => e.name)
  }, [query, icon])

  const shown = results.slice(0, MAX_ICON_RESULTS)

  return (
    <Popover
      className={cn('relative shrink-0', className)}
      panelClassName="absolute left-0 top-full z-50 mt-1.5 w-80 rounded-lg border border-neutral-200 bg-white p-3 shadow-xl"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          aria-label={label}
          aria-expanded={open}
          title={label}
          className={cn(
            'flex size-7 items-center justify-center rounded-md transition hover:brightness-95',
            chip,
            open && 'ring-2 ring-neutral-900 ring-offset-1',
          )}
        >
          <TriggerIcon className="size-4" />
        </button>
      )}
    >
      {() => (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-neutral-500">Color</p>
            <div className="grid grid-cols-10 gap-1.5">
              {AGENT_COLORS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  aria-label={c.key}
                  title={c.key}
                  aria-pressed={color === c.key}
                  onClick={() => onSelectColor(c.key)}
                  className={cn(
                    'size-5 rounded-full transition',
                    c.swatch,
                    color === c.key
                      ? 'ring-2 ring-neutral-900 ring-offset-1'
                      : 'opacity-70 hover:opacity-100',
                  )}
                />
              ))}
            </div>
          </div>

          <div className="space-y-1.5 border-t border-neutral-100 pt-3">
            <p className="text-xs font-medium text-neutral-500">Icon</p>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-neutral-400" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search all icons…"
                aria-label="Search icons"
                className="w-full rounded-md border border-neutral-200 bg-white py-1.5 pl-8 pr-3 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-400"
              />
            </div>

            {shown.length === 0 ? (
              <p className="py-6 text-center text-sm text-neutral-500">
                No icons match “{query.trim()}”.
              </p>
            ) : (
              <div className="grid max-h-52 grid-cols-8 gap-1 overflow-y-auto pr-0.5">
                {shown.map((name) => {
                  const Icon = ALL_AGENT_ICONS[name]
                  const selected = name === icon
                  return (
                    <button
                      key={name}
                      type="button"
                      title={name}
                      aria-label={name}
                      aria-pressed={selected}
                      onClick={() => onSelectIcon(name)}
                      className={cn(
                        'flex aspect-square items-center justify-center rounded-md border transition',
                        selected
                          ? cn('border-transparent', chip)
                          : 'border-transparent text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800',
                      )}
                    >
                      <Icon className="size-4" />
                    </button>
                  )
                })}
              </div>
            )}

            {results.length > MAX_ICON_RESULTS ? (
              <p className="text-[11px] text-neutral-400">
                Showing {MAX_ICON_RESULTS} of {results.length} — keep typing to
                narrow it down
              </p>
            ) : null}
          </div>
        </div>
      )}
    </Popover>
  )
}
