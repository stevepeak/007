import { ChevronRight, Info } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { cn } from './cn'

// A quiet, expandable note under a control. The SDK's editors carry a lot of
// explanatory prose — why a field exists, what it costs to get wrong — and set
// as a plain paragraph it reads as part of the form: as loud as the control it
// explains, and in the way once you've read it. This says the point in one
// line, marked as a hint (small, grey, an ⓘ), and keeps the reasoning behind a
// disclosure for the author who wants it.
//
// Use it for guidance. Errors and hard requirements stay full-size and visible.

export type HintProps = {
  /** The one line always shown — the point itself, not a teaser for it. */
  summary: ReactNode
  /** The reasoning, revealed on click. Omit for a hint with nothing more. */
  children?: ReactNode
  className?: string
}

export function Hint({ summary, children, className }: HintProps) {
  const [open, setOpen] = useState(false)
  const expandable = children != null

  return (
    <div className={cn('text-xs text-neutral-400', className)}>
      <button
        type="button"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex w-full items-start gap-1.5 text-left transition',
          expandable && 'hover:text-neutral-600',
        )}
      >
        <Info className="mt-px size-3.5 shrink-0" />
        <span>{summary}</span>
        {expandable ? (
          <ChevronRight
            className={cn(
              'mt-px size-3.5 shrink-0 transition-transform',
              open && 'rotate-90',
            )}
          />
        ) : null}
      </button>
      {expandable && open ? (
        <div className="mt-1.5 ml-5 leading-relaxed text-neutral-500">
          {children}
        </div>
      ) : null}
    </div>
  )
}
