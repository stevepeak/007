import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Search,
  TextSearch,
  X,
} from 'lucide-react'
import { type ReactNode, useMemo, useRef, useState } from 'react'

import type { ToolOption } from '../../server/protocol'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import { Segmented, type SegmentedOption } from '../filters'
import { ToolAvatar } from '../tool-appearance'

import {
  attachedGroups,
  groupDefault,
  detachGroup,
  groupTools,
  nameInGroup,
  setGroupDefault,
  setToolState,
  toolState,
  type ToolGroup,
  type ToolSelection,
  type ToolState,
} from './tool-selection'

// Tool selection for the agent editor, in two sections:
//
//   Tools — the host's and the SDK's own tools, picked one by one.
//   MCP   — connectors, attached whole. Each expands into its tools, and every
//           tool is in context, available (loaded by `search_tools` on demand)
//           or off. The connector's own setting is what tools the server adds
//           later get. See `./tool-selection` for how that maps onto the config.
//
// Selection state is owned by the caller so it plugs into the existing
// `patch({ toolIds, deferredToolIds, disabledToolIds })` flow.

export type { ToolSelection } from './tool-selection'

export type ToolPickerProps = {
  /** All AI tools available to select from (already filtered to `ai-tool`). */
  tools: ToolOption[]
  value: ToolSelection
  onChange: (next: ToolSelection) => void
  /** Placeholder for the empty-selection state. */
  emptyLabel?: string
  /**
   * Disable the whole picker — e.g. the selected model can't call tools. Any
   * already-attached tools are shown read-only so nothing silently vanishes.
   */
  disabled?: boolean
  /** Why the picker is disabled; shown in place of the search box. */
  disabledReason?: string
}

const STATE_OPTIONS: SegmentedOption<ToolState>[] = [
  {
    value: 'context',
    label: 'In context',
    icon: Eye,
    hint: 'In context — the model sees the full schema on every turn.',
  },
  {
    value: 'available',
    label: 'Available',
    icon: TextSearch,
    hint: 'Available — the model sees only the name, and loads it with search_tools when it needs it.',
  },
  {
    value: 'off',
    label: 'Off',
    icon: EyeOff,
    hint: 'Off — the agent cannot call it.',
  },
]

const DEFAULT_OPTIONS: SegmentedOption<ToolState>[] = STATE_OPTIONS.map((o) => {
  return { ...o, hint: `${o.hint} Also what tools this server adds later get.` }
})

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
  value,
  onChange,
  emptyLabel = 'No tools selected yet.',
  disabled = false,
  disabledReason,
}: ToolPickerProps) {
  const { Input } = useWfComponents()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { plainTools, groups } = useMemo(() => {
    const split = groupTools(tools)
    return {
      plainTools: split.plain,
      groups: new Map(split.groups.map((g) => [g.id, g])),
    }
  }, [tools])

  const selectedTools = plainTools.filter((t) => value.toolIds.includes(t.id))
  // Preserve the order tools were added in.
  selectedTools.sort(
    (a, b) => value.toolIds.indexOf(a.id) - value.toolIds.indexOf(b.id),
  )
  const attached = attachedGroups(value)
    .map((id) => groups.get(id))
    .filter((g): g is ToolGroup => g !== undefined)

  const results = useMemo(() => {
    const rank = <T,>(items: T[], name: (item: T) => string, score: (item: T) => number | null) => {
      return items
        .map((item) => ({ item, score: score(item) }))
        .filter((r): r is { item: T; score: number } => r.score !== null)
        .sort((a, b) => b.score - a.score || name(a.item).localeCompare(name(b.item)))
        .map((r) => r.item)
    }
    const attachedIds = new Set(attachedGroups(value))
    return {
      tools: rank(
        plainTools.filter((t) => !value.toolIds.includes(t.id)),
        (t) => t.name,
        (t) => matchTool(query, t),
      ),
      connectors: rank(
        [...groups.values()].filter((g) => !attachedIds.has(g.id)),
        (g) => g.label,
        (g) => matchConnector(query, g),
      ),
    }
  }, [plainTools, groups, value, query])
  const firstResult = results.tools[0] ?? results.connectors[0]

  function addTool(id: string) {
    onChange(setToolState(value, id, 'context'))
    setQuery('')
  }
  function addConnector(id: string) {
    // Available, not in context: a connector can be dozens of schemas.
    onChange(setGroupDefault(value, id, 'available'))
    setQuery('')
  }

  const hasSelection = selectedTools.length > 0 || attached.length > 0
  const selection = hasSelection ? (
    <div className={cn('space-y-3', disabled && 'pointer-events-none opacity-60')}>
      {selectedTools.length > 0 ? (
        <Section title="Tools">
          {selectedTools.map((t) => (
            <li
              key={t.id}
              className="flex items-center gap-2.5 rounded-md border border-border bg-card p-2"
            >
              <ToolRowContent tool={t} />
              <Segmented
                label={`${t.name} visibility`}
                variant="icon"
                options={STATE_OPTIONS.filter((o) => o.value !== 'off')}
                value={toolState(value, t.id)}
                onChange={(state) => onChange(setToolState(value, t.id, state))}
              />
              <RemoveButton
                name={t.name}
                onClick={() => onChange(setToolState(value, t.id, 'off'))}
              />
            </li>
          ))}
        </Section>
      ) : null}
      {attached.length > 0 ? (
        <Section title="MCP">
          {attached.map((g) => (
            <ConnectorEntry
              key={g.id}
              group={g}
              value={value}
              onChange={onChange}
            />
          ))}
        </Section>
      ) : null}
    </div>
  ) : null

  // Disabled (e.g. the model can't call tools): drop the search box and show the
  // reason. Anything already attached stays listed read-only.
  if (disabled) {
    return (
      <div className="space-y-2">
        {selection}
        <div className="rounded-md border border-dashed border-border bg-muted p-3 text-center text-xs text-muted-foreground">
          {disabledReason ?? 'The selected model can’t call tools.'}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {selection ?? (
        <div className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
          {emptyLabel}
        </div>
      )}

      {/* Fuzzy search */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => {
            if (blurTimerRef.current) clearTimeout(blurTimerRef.current)
            setOpen(true)
          }}
          onBlur={() => {
            // Delay so a result click lands before the list unmounts.
            blurTimerRef.current = setTimeout(() => setOpen(false), 120)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && firstResult) {
              e.preventDefault()
              if ('tools' in firstResult) addConnector(firstResult.id)
              else addTool(firstResult.id)
            } else if (e.key === 'Escape') {
              setOpen(false)
            }
          }}
          placeholder="Search tools and MCP servers to add…"
          className="pl-8"
        />

        {open ? (
          <div className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-md border border-border bg-popover p-1 shadow-lg">
            {!firstResult ? (
              <div className="p-2 text-xs text-muted-foreground">
                {tools.length === 0
                  ? 'No tools registered.'
                  : query.trim().length > 0
                    ? `Nothing matches “${query.trim()}”.`
                    : 'Everything is added.'}
              </div>
            ) : null}
            {results.tools.length > 0 ? (
              <ResultHeading>Tools</ResultHeading>
            ) : null}
            {results.tools.map((t) => (
              <ResultButton key={t.id} onPick={() => addTool(t.id)}>
                <ToolRowContent tool={t} />
              </ResultButton>
            ))}
            {results.connectors.length > 0 ? (
              <ResultHeading>MCP</ResultHeading>
            ) : null}
            {results.connectors.map((g) => (
              <ResultButton key={g.id} onPick={() => addConnector(g.id)}>
                <ConnectorRowContent group={g} />
              </ResultButton>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <ul className="space-y-1.5">{children}</ul>
    </div>
  )
}

function ResultHeading({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  )
}

function ResultButton({
  onPick,
  children,
}: {
  onPick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      // onMouseDown (not onClick) so it fires before the input's blur handler
      // closes the list.
      onMouseDown={(e) => {
        e.preventDefault()
        onPick()
      }}
      className="flex w-full items-center gap-2.5 rounded-md p-2 text-left transition-colors hover:bg-accent"
    >
      {children}
    </button>
  )
}

/** An attached connector: its default, and — expanded — each tool's state. */
function ConnectorEntry({
  group,
  value,
  onChange,
}: {
  group: ToolGroup
  value: ToolSelection
  onChange: (next: ToolSelection) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const counts = { context: 0, available: 0, off: 0 }
  for (const t of group.tools) counts[toolState(value, t.id)]++
  return (
    <li className="rounded-md border border-border bg-card">
      <div className="flex items-center gap-2.5 p-2">
        <button
          type="button"
          aria-label={expanded ? 'Hide tools' : 'Show tools'}
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          {expanded ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )}
        </button>
        <ToolAvatar tool={group.tools[0]} size="md" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {group.label}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {counts.context} in context · {counts.available} available ·{' '}
            {counts.off} off
          </span>
        </span>
        <Segmented
          label={`${group.label} default`}
          variant="icon"
          options={DEFAULT_OPTIONS}
          value={groupDefault(value, group.id)}
          onChange={(state) => {
            onChange(setGroupDefault(value, group.id, state))
          }}
        />
        <RemoveButton
          name={group.label}
          onClick={() => onChange(detachGroup(value, group.id))}
        />
      </div>
      {expanded ? (
        <ul className="space-y-0.5 border-t border-border px-2 py-1.5">
          {group.tools.map((t) => (
            <li
              key={t.id}
              className="flex items-center gap-2 rounded px-1 py-1 text-xs"
            >
              <span
                className="min-w-0 flex-1 truncate text-foreground"
                title={t.description}
              >
                {nameInGroup(t, group)}
              </span>
              <Segmented
                label={`${t.name} visibility`}
                variant="icon"
                options={STATE_OPTIONS}
                value={toolState(value, t.id)}
                onChange={(state) => onChange(setToolState(value, t.id, state))}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}

function RemoveButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Remove ${name}`}
      onClick={onClick}
      className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-red-50 hover:text-red-600"
    >
      <X className="size-4" />
    </button>
  )
}

/** Fuzzy match for a connector, by its name or any of its tools. */
function matchConnector(query: string, group: ToolGroup): number | null {
  if (query.trim().length === 0) return 0
  const own = fuzzyScore(query, group.label)
  if (own !== null) return own * 2
  const best = group.tools
    .map((t) => matchTool(query, t))
    .filter((s): s is number => s !== null)
  return best.length > 0 ? Math.max(...best) : null
}

/** A connector's avatar, name and tool count. */
function ConnectorRowContent({ group }: { group: ToolGroup }) {
  return (
    <>
      <ToolAvatar tool={group.tools[0]} size="md" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {group.label}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {group.tools.length} tools
        </span>
      </span>
    </>
  )
}

/** A tool's avatar, name and one-line description — the body of every row. */
function ToolRowContent({ tool }: { tool: ToolOption }) {
  return (
    <>
      <ToolAvatar tool={tool} size="md" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {tool.name}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {tool.description}
        </span>
      </span>
    </>
  )
}
