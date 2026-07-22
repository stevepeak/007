import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'

import { cn } from '../../cn'

// Small, shared presentational atoms for the run report.

// A collapsible bordered card: a clickable header (chevron + title + optional
// subtitle) over content that folds away. Each section owns its open state.
export function Section({
  title,
  subtitle,
  defaultOpen = true,
  children,
}: {
  title: string
  subtitle?: React.ReactNode
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition hover:bg-neutral-50"
      >
        {open ? (
          <ChevronDown className="size-4 shrink-0 text-neutral-400" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-neutral-400" />
        )}
        <span className="text-sm font-semibold text-neutral-900">{title}</span>
        {subtitle != null && (
          <span className="text-xs text-neutral-400">{subtitle}</span>
        )}
      </button>
      {open && <div className="border-t border-neutral-100">{children}</div>}
    </div>
  )
}

// A single small dot + word — the calm, scannable status marker for a table row
// (the full colored badge stays on the run-level summary only).
export function StatusDot({ status }: { status: string }) {
  const tone =
    status === 'pass'
      ? { dot: 'bg-emerald-500', text: 'text-emerald-700' }
      : status === 'error'
        ? { dot: 'bg-amber-500', text: 'text-amber-700' }
        : status === 'fail'
          ? { dot: 'bg-red-500', text: 'text-red-700' }
          : { dot: 'bg-neutral-300', text: 'text-neutral-500' }
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', tone.text)}>
      <span className={cn('size-1.5 rounded-full', tone.dot)} />
      {status}
    </span>
  )
}

// The filled status pill used on the run-level summary header.
export function VerdictBadge({ status }: { status: string }) {
  const tone =
    status === 'pass' || status === 'completed'
      ? 'bg-emerald-50 text-emerald-700'
      : status === 'error'
        ? 'bg-amber-50 text-amber-700'
        : status === 'fail' || status === 'failed' || status === 'cancelled'
          ? 'bg-red-50 text-red-700'
          : 'bg-neutral-100 text-neutral-500'
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium',
        tone,
      )}
    >
      {status}
    </span>
  )
}
