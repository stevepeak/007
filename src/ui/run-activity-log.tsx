import {
  AlertTriangle,
  Brain,
  Check,
  ChevronRight,
  Info,
  Wrench,
} from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import type { LucideIcon } from 'lucide-react'

import type { WfRunLogDTO } from '../server/protocol'
import { cn } from './cn'
import { formatClock } from './cost'

// The run viewer's run-wide progress feed — the "Activity" tab of the dock. A
// chronological, console-style stream of the structured entries the engine
// emits (a node entered/finished, an agent's internal reasoning, a tool call,
// an error). Distinct from the per-node "Logs" tab (`RunLog`), which shows one
// selected node's machine trace. This is the narrative of the whole run and,
// while the run is live, updates as `useRun` polls.

type Level = WfRunLogDTO['level']

const LEVEL_STYLE: Record<
  string,
  { icon: LucideIcon; tone: string; iconTone: string }
> = {
  'node-start': {
    icon: ChevronRight,
    tone: 'text-neutral-800',
    iconTone: 'text-blue-500',
  },
  'node-end': {
    icon: Check,
    tone: 'text-neutral-500',
    iconTone: 'text-emerald-500',
  },
  thinking: {
    icon: Brain,
    tone: 'text-violet-700',
    iconTone: 'text-violet-400',
  },
  tool: { icon: Wrench, tone: 'text-sky-700', iconTone: 'text-sky-400' },
  info: { icon: Info, tone: 'text-neutral-600', iconTone: 'text-neutral-400' },
  warn: {
    icon: AlertTriangle,
    tone: 'text-amber-700',
    iconTone: 'text-amber-500',
  },
  error: {
    icon: AlertTriangle,
    tone: 'text-rose-700',
    iconTone: 'text-rose-500',
  },
}

function styleFor(level: Level) {
  return LEVEL_STYLE[level] ?? LEVEL_STYLE.info
}

export type RunActivityLogProps = {
  logs: WfRunLogDTO[]
  /** True while the run is still executing — shows a live "listening" footer. */
  live?: boolean
  /** Highlight rows for this node (the one selected on the graph). */
  selectedNodeId?: string | null
  /** Click a row to select its node on the graph. */
  onSelectNode?: (nodeId: string) => void
  /** Double-click a row to select its node AND open its Inspect view. */
  onInspectNode?: (nodeId: string) => void
}

// Compact duration for a completed node, e.g. "820ms", "35s", "2m 3s".
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s % 60)}s`
}

export function RunActivityLog({
  logs,
  live,
  selectedNodeId,
  onSelectNode,
  onInspectNode,
}: RunActivityLogProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null)

  // Stable ascending order (the API already sorts by ts, but a shared ts on
  // sibling entries is resolved by sequence for a deterministic read).
  const ordered = useMemo(
    () =>
      [...logs].sort(
        (a, b) => a.ts - b.ts || (a.sequence ?? 0) - (b.sequence ?? 0),
      ),
    [logs],
  )

  // How long each node took: pair every `node-end` with its preceding
  // `node-start` (same nodeId) and stash the elapsed time by row index, so a
  // completed node's ✓ line can show "35s".
  const durations = useMemo(() => {
    const startedAt = new Map<string, number>()
    const byIndex = new Map<number, number>()
    ordered.forEach((entry, i) => {
      if (!entry.nodeId) return
      if (entry.level === 'node-start') {
        startedAt.set(entry.nodeId, entry.ts)
      } else if (entry.level === 'node-end') {
        const start = startedAt.get(entry.nodeId)
        if (start != null && entry.ts >= start) byIndex.set(i, entry.ts - start)
      }
    })
    return byIndex
  }, [ordered])

  // Auto-scroll to the newest line while the run is live (console behaviour).
  useEffect(() => {
    if (live) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [ordered.length, live])

  if (ordered.length === 0) {
    return (
      <p className="text-xs text-neutral-500">
        {live
          ? 'Waiting for the first step to report…'
          : 'This run produced no activity log.'}
      </p>
    )
  }

  return (
    <div className="font-mono text-[11px] leading-relaxed">
      {ordered.map((entry, i) => {
        const s = styleFor(entry.level)
        const Icon = s.icon
        const selected =
          !!entry.nodeId && !!selectedNodeId && entry.nodeId === selectedNodeId
        const clickable = !!entry.nodeId && !!onSelectNode
        const duration = durations.get(i)
        return (
          <div
            key={`${entry.ts}-${entry.sequence ?? 0}-${i}`}
            onClick={
              clickable ? () => onSelectNode!(entry.nodeId as string) : undefined
            }
            onDoubleClick={
              entry.nodeId && onInspectNode
                ? () => onInspectNode(entry.nodeId as string)
                : undefined
            }
            className={cn(
              'flex items-start gap-2 rounded px-1.5 py-0.5',
              clickable && 'cursor-pointer select-none hover:bg-neutral-100',
              selected && 'bg-blue-50',
            )}
          >
            <span className="shrink-0 tabular-nums text-neutral-300">
              {formatClock(entry.ts)}
            </span>
            <Icon className={cn('mt-0.5 size-3 shrink-0', s.iconTone)} />
            <span className={cn('min-w-0 break-words whitespace-pre-wrap', s.tone)}>
              {entry.message}
            </span>
            {duration != null ? (
              <span className="ml-auto shrink-0 tabular-nums text-emerald-600">
                {fmtDuration(duration)}
              </span>
            ) : null}
          </div>
        )
      })}
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
