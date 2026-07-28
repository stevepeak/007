import { Check, Search } from 'lucide-react'
import { useMemo, useState } from 'react'

import {
  ALL_AGENT_ICON_NAMES,
  ALL_AGENT_ICONS,
  agentColor,
} from '../agent-appearance'
import { cn } from '../cn'
import { Modal } from '../modal'

// A searchable popup over the full lucide icon set (~1750 icons). The agent
// editor's appearance row shows a curated shortlist; this is the "browse all"
// escape hatch. Icons are stored by their PascalCase name, so search matches
// against a whitespace-separated form of that name (e.g. "FileSearch" →
// "file search"). We cap how many buttons render at once so a query-less open
// doesn't paint two thousand SVGs — the hint nudges the user to narrow it.

const MAX_RESULTS = 300

// "FileSearch" / "AArrowDown" → "file search" / "a arrow down" for matching.
function searchable(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
}

const SEARCH_INDEX: { name: string; haystack: string }[] =
  ALL_AGENT_ICON_NAMES.map((name) => ({ name, haystack: searchable(name) }))

export type IconPickerProps = {
  open: boolean
  /** Currently-selected icon name, highlighted in the grid. */
  value: string
  /** The agent's color key — the selected icon previews in that color chip. */
  color: string
  onSelect: (name: string) => void
  onClose: () => void
}

export function IconPicker({
  open,
  value,
  color,
  onSelect,
  onClose,
}: IconPickerProps) {
  const [query, setQuery] = useState('')

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return SEARCH_INDEX
    const terms = q.split(/\s+/)
    return SEARCH_INDEX.filter((e) =>
      terms.every((t) => e.haystack.includes(t)),
    )
  }, [query])

  const shown = results.slice(0, MAX_RESULTS)
  const chip = agentColor(color).chip

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Choose an icon"
      panelClassName="flex max-h-[80vh] w-full max-w-lg flex-col rounded-lg border border-neutral-200 bg-white shadow-xl"
    >
      <div className="border-b border-neutral-200 px-5 py-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-neutral-400" />
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search icons…"
            aria-label="Search icons"
            className="w-full rounded-md border border-neutral-200 bg-white py-1.5 pl-8 pr-3 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-400"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {shown.length === 0 ? (
          <p className="py-8 text-center text-sm text-neutral-500">
            No icons match “{query.trim()}”.
          </p>
        ) : (
          <div className="grid grid-cols-8 gap-1.5">
            {shown.map(({ name }) => {
              const Icon = ALL_AGENT_ICONS[name]
              const selected = name === value
              return (
                <button
                  key={name}
                  type="button"
                  title={name}
                  aria-label={name}
                  aria-pressed={selected}
                  onClick={() => {
                    onSelect(name)
                    onClose()
                  }}
                  className={cn(
                    'flex aspect-square items-center justify-center rounded-md border transition',
                    selected
                      ? cn('border-transparent', chip)
                      : 'border-neutral-200 text-neutral-500 hover:border-neutral-300 hover:text-neutral-800',
                  )}
                >
                  <Icon className="size-4" />
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-neutral-200 px-5 py-2.5 text-xs text-neutral-400">
        <span>
          {results.length > MAX_RESULTS
            ? `Showing ${MAX_RESULTS} of ${results.length} — keep typing to narrow it down`
            : `${results.length} icon${results.length === 1 ? '' : 's'}`}
        </span>
        {value ? (
          <span className="flex items-center gap-1 text-neutral-500">
            <Check className="size-3" />
            {value}
          </span>
        ) : null}
      </div>
    </Modal>
  )
}
