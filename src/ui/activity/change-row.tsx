import { useState } from 'react'

import type { WfChangeDTO } from '../../server/protocol'
import { cn } from '../cn'
import { DataView } from '../data-view'
import { formatTimestamp } from '../evals/shared'

import { changeActor, changeSummary } from './change-summary'
import { HistoryDot } from './history-dot'

// One row of the change feed: what happened, who did it, when — and, on click,
// the payloads either side of it.
//
// The payloads are collapsed by default on purpose. Ninety-nine reads of this
// feed are "when did this move and who moved it", and a wall of JSON buries the
// answer to that in the answer to a question nobody asked.

export function ChangeRow({
  change,
  muted,
}: {
  change: WfChangeDTO
  /** Dim the rail dot — only the newest row is dark, matching the editor menu. */
  muted?: boolean
}) {
  const [open, setOpen] = useState(false)
  const hasPayload = change.before != null || change.after != null

  return (
    <div className="flex items-stretch gap-2">
      <HistoryDot muted={muted} />
      <div className="min-w-0 flex-1 pb-3">
        <button
          type="button"
          onClick={() => hasPayload && setOpen((o) => !o)}
          className={cn(
            'block w-full text-left',
            hasPayload ? 'cursor-pointer' : 'cursor-default',
          )}
        >
          <span className="text-sm text-neutral-800">
            <span className="font-medium">{changeActor(change)}</span>{' '}
            {changeSummary(change)}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-neutral-500">
            <span>{formatTimestamp(change.createdAt)}</span>
            {change.note ? (
              <span className="truncate italic">“{change.note}”</span>
            ) : null}
            {/* "We didn't keep it" and "nothing changed" are different claims. */}
            {change.truncated ? (
              <span className="text-neutral-400">detail too large to keep</span>
            ) : null}
          </span>
        </button>
        {open && hasPayload ? (
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <PayloadPane label="Before" value={change.before} />
            <PayloadPane label="After" value={change.after} />
          </div>
        ) : null}
      </div>
    </div>
  )
}

function PayloadPane({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
        {label}
      </p>
      {value == null ? (
        <p className="text-xs text-neutral-400">—</p>
      ) : (
        <DataView value={value} />
      )}
    </div>
  )
}
