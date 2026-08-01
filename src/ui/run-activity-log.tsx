import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDashed,
  Info,
  Minus,
  Wrench,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'

import type { WorkflowGraph } from '../engine'
import type { WfRunLogDTO, WfRunStepDTO } from '../server/protocol'
import { cn } from './cn'
import { formatClock, formatDurationMs, formatUsd } from './cost'
import { KIND_STYLE } from './editor/node-renderers-shared'
import { runStatusDotClass } from './run-status'
import {
  buildActivityTree,
  flattenTree,
  type ActivityStatus,
  type FlatRow,
} from './run-activity-tree'

// The run viewer's run-wide progress feed — the "Activity" tab of the dock. A
// living, tree-shaped view of the run: every workflow node is a row (spinner
// while running, ✓ + duration when done, ✕ when failed), and sub-tasks nest
// under their parent — the per-item sub-nodes inside a loop/iteration and an
// agent's delegated sub-agent runs, which the old flat log stream couldn't
// show. The tree skeleton is derived from the recorded steps (which carry the
// parent/item hierarchy) in `run-activity-tree.ts`; agent thinking / tool lines
// hang off their node as leaves. Distinct from the per-node "Inspect" tab
// (`RunLog`). While the run is live, it re-derives as `useRun` polls.

// Icon + colour for a log leaf line, keyed by its level.
const LEVEL_STYLE: Record<string, { icon: LucideIcon; tone: string; iconTone: string }> = {
  thinking: { icon: Brain, tone: 'text-violet-700', iconTone: 'text-violet-400' },
  tool: { icon: Wrench, tone: 'text-sky-700', iconTone: 'text-sky-400' },
  info: { icon: Info, tone: 'text-neutral-600', iconTone: 'text-neutral-400' },
  warn: { icon: AlertTriangle, tone: 'text-amber-700', iconTone: 'text-amber-500' },
  error: { icon: AlertTriangle, tone: 'text-rose-700', iconTone: 'text-rose-500' },
}

function logStyle(level: string) {
  return LEVEL_STYLE[level] ?? LEVEL_STYLE.info
}

// Type icon + colour + label for a node row, reusing the editor's per-kind
// palette (`KIND_STYLE`). Its accent is a `border-l-<colour>` class, which we
// retone to a `text-<colour>` for the icon. Unknown kinds fall back to a
// neutral dot labelled by the raw kind.
const KIND_PALETTE = KIND_STYLE as Record<
  string,
  { icon: LucideIcon; accent: string; label: string }
>
function kindPresentation(kind: string): {
  Icon: LucideIcon
  tone: string
  label: string
} {
  const s = KIND_PALETTE[kind]
  if (s)
    return {
      Icon: s.icon,
      tone: s.accent.replace('border-l-', 'text-'),
      label: s.label,
    }
  return { Icon: Circle, tone: 'text-neutral-400', label: kind }
}

// Status glyph for a node row: a spinning ring while running, ✓/✕ on finish, a
// muted dash for skipped, and a faint hollow ring for not-yet-run nodes.
function StatusGlyph({ status }: { status: ActivityStatus }) {
  switch (status) {
    case 'running':
      return <CircleDashed className="size-3 shrink-0 animate-spin text-blue-500" />
    case 'completed':
      return <Check className="size-3 shrink-0 text-emerald-500" />
    case 'failed':
      return <X className="size-3 shrink-0 text-rose-500" />
    case 'skipped':
      return <Minus className="size-3 shrink-0 text-neutral-300" />
    default:
      return <CircleDashed className="size-3 shrink-0 text-neutral-300" />
  }
}

export type RunActivityLogProps = {
  logs: WfRunLogDTO[]
  /** Recorded steps — the tree skeleton (loop items, sub-agent delegations). */
  steps: WfRunStepDTO[]
  /** The run's graph at the version that ran — supplies labels + pending rows. */
  graph: WorkflowGraph | null
  /** True while the run is still executing — shows a live "listening" footer. */
  live?: boolean
  /** Highlight rows for this node (the one selected on the graph). */
  selectedNodeId?: string | null
  /** Which iteration item is focused, so only that item's inner rows highlight. */
  selectedItemIndex?: number | null
  /** Click a row to select its node on the graph. */
  onSelectNode?: (nodeId: string) => void
  /** Double-click a row to select its node AND open its Inspect view. */
  onInspectNode?: (nodeId: string) => void
  /** Focus an iteration item (drives the dock's per-item picker). */
  onSelectItem?: (index: number) => void
}

const INDENT = 14
const BASE_PAD = 6

export function RunActivityLog({
  logs,
  steps,
  graph,
  live,
  selectedNodeId,
  selectedItemIndex,
  onSelectNode,
  onInspectNode,
  onSelectItem,
}: RunActivityLogProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null)
  // Explicit expand/collapse overrides, keyed by stable row identity so a
  // user's toggle survives the 1.5s poll that rebuilds the tree.
  const [overrides, setOverrides] = useState<Map<string, 'open' | 'closed'>>(
    () => new Map(),
  )

  const tree = useMemo(
    () => buildActivityTree({ graph, steps, logs, live }),
    [graph, steps, logs, live],
  )
  const flat = useMemo(() => flattenTree(tree, overrides), [tree, overrides])

  // Auto-scroll to the newest row while the run is live (console behaviour).
  useEffect(() => {
    if (live) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [flat.length, live])

  const toggle = useCallback((key: string, expanded: boolean) => {
    setOverrides((prev) => {
      const next = new Map(prev)
      next.set(key, expanded ? 'closed' : 'open')
      return next
    })
  }, [])

  if (flat.length === 0) {
    return (
      <p className="text-xs text-neutral-500">
        {live
          ? 'Waiting for the first step to report…'
          : 'This run produced no activity.'}
      </p>
    )
  }

  return (
    <div className="text-[11px] leading-relaxed">
      {flat.map((f) => (
        <ActivityRowView
          key={f.row.key}
          flat={f}
          selectedNodeId={selectedNodeId}
          selectedItemIndex={selectedItemIndex}
          onToggle={toggle}
          onSelectNode={onSelectNode}
          onInspectNode={onInspectNode}
          onSelectItem={onSelectItem}
        />
      ))}
      {live ? (
        <div className="flex items-center gap-2 px-1.5 py-1 text-neutral-400">
          <span className="size-1.5 animate-pulse rounded-full bg-blue-500" />
          <span>listening…</span>
        </div>
      ) : null}
      <div ref={bottomRef} />
    </div>
  )
}

function ActivityRowView({
  flat,
  selectedNodeId,
  selectedItemIndex,
  onToggle,
  onSelectNode,
  onInspectNode,
  onSelectItem,
}: {
  flat: FlatRow
  selectedNodeId?: string | null
  selectedItemIndex?: number | null
  onToggle: (key: string, expanded: boolean) => void
  onSelectNode?: (nodeId: string) => void
  onInspectNode?: (nodeId: string) => void
  onSelectItem?: (index: number) => void
}) {
  const { row, depth, expanded, hasChildren } = flat
  const pad = depth * INDENT + BASE_PAD

  const caret = hasChildren ? (
    <button
      type="button"
      aria-label={expanded ? 'Collapse' : 'Expand'}
      onClick={(e) => {
        e.stopPropagation()
        onToggle(row.key, expanded)
      }}
      className="-ml-0.5 shrink-0 rounded p-0.5 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-600"
    >
      {expanded ? (
        <ChevronDown className="size-3" />
      ) : (
        <ChevronRight className="size-3" />
      )}
    </button>
  ) : (
    <span className="w-3.5 shrink-0" />
  )

  if (row.kind === 'log') {
    const s = logStyle(row.level)
    const Icon = s.icon
    return (
      <div
        style={{ paddingLeft: pad }}
        className="flex items-start gap-2 py-0.5 pr-1.5 font-mono"
      >
        {caret}
        <span className="shrink-0 tabular-nums text-neutral-300">
          {formatClock(row.ts)}
        </span>
        <Icon className={cn('mt-0.5 size-3 shrink-0', s.iconTone)} />
        <span className={cn('min-w-0 break-words whitespace-pre-wrap', s.tone)}>
          {row.message}
        </span>
      </div>
    )
  }

  if (row.kind === 'group') {
    const selected =
      selectedNodeId === row.containerNodeId &&
      selectedItemIndex === row.itemIndex
    return (
      <div
        style={{ paddingLeft: pad }}
        onClick={() => {
          onSelectNode?.(row.containerNodeId)
          onSelectItem?.(row.itemIndex)
        }}
        className={cn(
          'flex items-center gap-2 rounded py-0.5 pr-1.5 select-none',
          onSelectNode && 'cursor-pointer hover:bg-neutral-100',
          selected && 'bg-blue-50',
        )}
      >
        {caret}
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            runStatusDotClass[row.status] ?? 'bg-neutral-300',
          )}
        />
        <span className="font-medium text-neutral-600">{row.label}</span>
      </div>
    )
  }

  // Node row.
  const selected =
    selectedNodeId === row.nodeId &&
    (row.itemIndex == null || row.itemIndex === selectedItemIndex)
  const clickable = !!onSelectNode
  return (
    <div
      style={{ paddingLeft: pad }}
      onClick={
        clickable
          ? () => {
              onSelectNode?.(row.selectNodeId)
              if (row.itemIndex != null) onSelectItem?.(row.itemIndex)
            }
          : undefined
      }
      onDoubleClick={
        onInspectNode ? () => onInspectNode(row.selectNodeId) : undefined
      }
      className={cn(
        'flex items-center gap-2 rounded py-0.5 pr-1.5',
        clickable && 'cursor-pointer select-none hover:bg-neutral-100',
        selected && 'bg-blue-50',
        row.status === 'pending' && 'text-neutral-400',
      )}
      title={row.error ?? undefined}
    >
      {caret}
      <StatusGlyph status={row.status} />
      {(() => {
        const k = kindPresentation(row.nodeKind)
        const pending = row.status === 'pending'
        return (
          <>
            <k.Icon
              className={cn('size-3 shrink-0', k.tone, pending && 'opacity-50')}
            />
            <span className="shrink-0 text-neutral-400">{k.label}</span>
          </>
        )
      })()}
      <span
        className={cn(
          'min-w-0 truncate font-medium',
          row.status === 'failed'
            ? 'text-rose-700'
            : row.status === 'pending'
              ? 'text-neutral-400'
              : 'text-neutral-800',
        )}
      >
        {row.label}
      </span>
      {row.error ? (
        <span className="min-w-0 truncate text-rose-500">— {row.error}</span>
      ) : null}
      {(row.itemsTotal != null ||
        (row.nodeKind === 'agent' && row.costUsd != null) ||
        row.durationMs != null) && (
        <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums">
          {row.itemsTotal != null ? (
            <span className="text-fuchsia-600">
              {row.itemsDone ?? 0}/{row.itemsTotal}
            </span>
          ) : null}
          {row.nodeKind === 'agent' && row.costUsd != null ? (
            <span className="text-neutral-500">{formatUsd(row.costUsd)}</span>
          ) : null}
          {row.durationMs != null ? (
            <span className="text-emerald-600">
              {formatDurationMs(row.durationMs)}
            </span>
          ) : null}
        </span>
      )}
    </div>
  )
}
