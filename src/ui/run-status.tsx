import { CircleDashed } from 'lucide-react'

import { cn } from './cn'
import { useWfComponents } from './context'

// Shared run/step status styling. The same status → colour mapping was copied
// across the runs explorer, run page, node dock, tool detail and run viewer;
// this is the single source of truth for the border-pill palette, the canvas
// dot palette, and the spinner-aware badge component.

// Border-pill classes for an injected <Badge> (`cn('border', runStatusClass[s])`).
// Statuses not present fall through to a plain border (cn drops undefined).
export const runStatusClass: Record<string, string> = {
  completed: 'bg-green-100 text-green-700 border-green-200',
  running: 'bg-blue-100 text-blue-700 border-blue-200',
  failed: 'bg-red-100 text-red-700 border-red-200',
  queued: 'bg-amber-100 text-amber-700 border-amber-200',
  cancelled: 'bg-neutral-100 text-neutral-500 border-neutral-200',
  skipped: 'bg-neutral-100 text-neutral-500 border-neutral-200',
}

// Solid dot classes for the corner status marker on a workflow-canvas node.
// Kept separate from runStatusClass on purpose: these are fill-only colours
// (no border/text) tuned for a 2.5px dot, not the pill palette.
export const runStatusDotClass: Record<string, string> = {
  completed: 'bg-emerald-500',
  failed: 'bg-rose-500',
  running: 'bg-blue-500 animate-pulse',
  skipped: 'bg-neutral-300',
  queued: 'bg-amber-400',
}

// The canonical run-status badge: an animated pill while pending/active, else a
// coloured border badge. Used by the runs explorer table.
export function RunStatusBadge({ status }: { status: string }) {
  const { Badge } = useWfComponents()
  if (status === 'running' || status === 'queued') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700">
        <CircleDashed className="size-3 animate-spin" />
        {status}
      </span>
    )
  }
  return <Badge className={cn('border', runStatusClass[status])}>{status}</Badge>
}
