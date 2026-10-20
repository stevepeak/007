import { Check, CircleDashed, Minus, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '../cn'
import { useWfComponents } from '../context'

// Shared run/step status styling — the single source of truth for every
// surface that colours a run or step by its status. One row per status; each
// field is a different rendering of the same status, sized for its surface.
type RunStatusStyle = {
  /** Border pill for an injected <Badge> (`cn('border', pill)`). */
  pill: string
  /** Fill-only colour for a small solid dot (canvas corner marker, feed rows). */
  dot: string
  /** Text tone for a status word written inline. */
  text: string
  /**
   * Borderless tint for a tiny square chip (an iteration's per-item grid). Only
   * outcomes get one: an item still in flight stays neutral so the grid reads
   * as "what finished, and how".
   */
  chip?: string
  /** Icon + tone for a row glyph; absent statuses render a hollow ring. */
  glyph?: { icon: LucideIcon; className: string }
}

export const RUN_STATUS_STYLE: Record<string, RunStatusStyle> = {
  completed: {
    pill: 'bg-green-100 text-green-700 border-green-200',
    dot: 'bg-emerald-500',
    text: 'text-emerald-700',
    chip: 'bg-green-100 text-green-700',
    glyph: { icon: Check, className: 'text-emerald-500' },
  },
  // Answer delivered, background arms still draining — green (it succeeded)
  // but distinct from a fully settled run, so reading it as "finished" is
  // never the easy mistake.
  done: {
    pill: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    dot: 'bg-emerald-400',
    text: 'text-emerald-600',
  },
  running: {
    pill: 'bg-blue-100 text-blue-700 border-blue-200',
    dot: 'bg-blue-500 animate-pulse',
    text: 'text-blue-600',
    glyph: { icon: CircleDashed, className: 'animate-spin text-blue-500' },
  },
  failed: {
    pill: 'bg-red-100 text-red-700 border-red-200',
    dot: 'bg-rose-500',
    text: 'text-rose-600',
    chip: 'bg-red-100 text-red-700',
    glyph: { icon: X, className: 'text-rose-500' },
  },
  queued: {
    pill: 'bg-amber-100 text-amber-700 border-amber-200',
    dot: 'bg-amber-400',
    text: 'text-amber-600',
  },
  cancelled: {
    pill: 'bg-neutral-100 text-neutral-500 border-neutral-200',
    dot: 'bg-neutral-300',
    text: 'text-neutral-500',
  },
  skipped: {
    pill: 'bg-neutral-100 text-neutral-500 border-neutral-200',
    dot: 'bg-neutral-300',
    text: 'text-neutral-500',
    glyph: { icon: Minus, className: 'text-neutral-300' },
  },
}

function column(args: { field: 'pill' | 'dot' }): Record<string, string> {
  return Object.fromEntries(
    Object.entries(RUN_STATUS_STYLE).map(([s, v]) => [s, v[args.field]]),
  )
}

// Statuses not present fall through to a plain border (cn drops undefined).
export const runStatusClass = column({ field: 'pill' })
export const runStatusDotClass = column({ field: 'dot' })

// Status glyph for a row: a spinning ring while running, ✓/✕ on finish, a muted
// dash for skipped, and a faint hollow ring for anything not yet run.
export function RunStatusGlyph({ status }: { status: string }) {
  const glyph = RUN_STATUS_STYLE[status]?.glyph
  const Icon = glyph?.icon ?? CircleDashed
  return (
    <Icon
      className={cn('size-3 shrink-0', glyph?.className ?? 'text-neutral-300')}
    />
  )
}

// The canonical run-status badge: an animated pill while pending/active, else a
// coloured border badge. Used by the runs explorer table. Statuses are stored
// lowercase; `capitalize` presents them as labels without forking the values.
export function RunStatusBadge({ status }: { status: string }) {
  const { Badge } = useWfComponents()
  if (status === 'running' || status === 'queued') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium capitalize text-sky-700">
        <CircleDashed className="size-3 animate-spin" />
        {status}
      </span>
    )
  }
  return (
    <Badge className={cn('border capitalize', runStatusClass[status])}>
      {status}
    </Badge>
  )
}
