import { Search, Wrench, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

import type { ToolOption } from '../../server/protocol'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import { ToolIcon } from '../tool-icon'

// Tool selection for the agent/tool-node editors. Replaces the old checkbox
// list: pick tools by fuzzy-searching the registry, and manage the selection as
// deletable cards. Selection state is owned by the caller (`selectedIds` +
// `onChange`) so it plugs into the existing `patch({ toolIds })` flow.

export type ToolPickerProps = {
  /** All AI tools available to select from (already filtered to `ai-tool`). */
  tools: ToolOption[]
  /** Currently-selected tool ids, in selection order. */
  selectedIds: string[]
  onChange: (ids: string[]) => void
  /** Placeholder for the empty-selection state. */
  emptyLabel?: string
}

/**
 * Subsequence fuzzy score: every char of `query` must appear in order in
 * `text`. Consecutive hits and hits at word boundaries score higher, so
 * "kbs" ranks "Knowledge Base Search" above an incidental scatter match.
 * Returns `null` when `text` doesn't contain the subsequence at all.
 */
function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (q.length === 0) return 0
  let qi = 0
  let score = 0
  let streak = 0
  let prev = -2
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue
    streak = prev === ti - 1 ? streak + 1 : 1
    const boundary = ti === 0 || /[\s\-_]/.test(t[ti - 1] ?? '')
    score += streak + (boundary ? 2 : 0)
    prev = ti
    qi++
  }
  return qi === q.length ? score : null
}

/** Best fuzzy match across a tool's name (weighted) and description. */
function matchTool(query: string, tool: ToolOption): number | null {
  if (query.trim().length === 0) return 0
  const nameScore = fuzzyScore(query, tool.name)
  const descScore = fuzzyScore(query, tool.description)
  if (nameScore === null && descScore === null) return null
  return Math.max(
    nameScore === null ? -Infinity : nameScore * 2,
    descScore === null ? -Infinity : descScore,
  )
}

export function ToolPicker({
  tools,
  selectedIds,
  onChange,
  emptyLabel = 'No tools selected yet.',
}: ToolPickerProps) {
  const { Input } = useWfComponents()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const byId = useMemo(() => new Map(tools.map((t) => [t.id, t])), [tools])
  const selected = selectedIds
    .map((id) => byId.get(id))
    .filter((t): t is ToolOption => t !== undefined)

  // Candidates: unselected tools, fuzzy-filtered and ranked. With no query we
  // still show everything (highest-value discovery), ordered by name.
  const results = useMemo(() => {
    const selectedSet = new Set(selectedIds)
    return tools
      .filter((t) => !selectedSet.has(t.id))
      .map((t) => ({ tool: t, score: matchTool(query, t) }))
      .filter((r): r is { tool: ToolOption; score: number } => r.score !== null)
      .sort(
        (a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name),
      )
      .map((r) => r.tool)
  }, [tools, selectedIds, query])

  function add(id: string) {
    if (!selectedIds.includes(id)) onChange([...selectedIds, id])
    setQuery('')
  }
  function remove(id: string) {
    onChange(selectedIds.filter((i) => i !== id))
  }

  return (
    <div className="space-y-2">
      {/* Selected tools — deletable cards */}
      {selected.length > 0 ? (
        <ul className="space-y-1.5">
          {selected.map((t) => (
            <li
              key={t.id}
              className="flex items-center gap-2.5 rounded-md border border-neutral-200 bg-white p-2"
            >
              <ToolIcon icon={t.icon} className="size-6 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-neutral-800">
                  {t.name}
                </span>
                <span className="block truncate text-xs text-neutral-400">
                  {t.description}
                </span>
              </span>
              <button
                type="button"
                aria-label={`Remove ${t.name}`}
                onClick={() => remove(t.id)}
                className="shrink-0 rounded p-1 text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600"
              >
                <X className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-md border border-dashed border-neutral-200 p-3 text-center text-xs text-neutral-400">
          {emptyLabel}
        </div>
      )}

      {/* Fuzzy search */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-neutral-400" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => {
            if (blurTimer.current) clearTimeout(blurTimer.current)
            setOpen(true)
          }}
          onBlur={() => {
            // Delay so a result click lands before the list unmounts.
            blurTimer.current = setTimeout(() => setOpen(false), 120)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && results[0]) {
              e.preventDefault()
              add(results[0].id)
            } else if (e.key === 'Escape') {
              setOpen(false)
            }
          }}
          placeholder="Search tools to add…"
          className="pl-8"
        />

        {open ? (
          <div className="absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-md border border-neutral-200 bg-white p-1 shadow-lg">
            {results.length === 0 ? (
              <div className="p-2 text-xs text-neutral-400">
                {tools.length === 0
                  ? 'No tools registered.'
                  : query.trim().length > 0
                    ? `No tools match “${query.trim()}”.`
                    : 'All tools added.'}
              </div>
            ) : (
              results.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  // onMouseDown (not onClick) so it fires before the input's
                  // blur handler closes the list.
                  onMouseDown={(e) => {
                    e.preventDefault()
                    add(t.id)
                  }}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md p-2 text-left transition-colors hover:bg-neutral-50',
                  )}
                >
                  <ToolIcon icon={t.icon} className="size-6 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-neutral-800">
                      {t.name}
                    </span>
                    <span className="block truncate text-xs text-neutral-400">
                      {t.description}
                    </span>
                  </span>
                  <Wrench className="size-3.5 shrink-0 text-neutral-300" />
                </button>
              ))
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}
