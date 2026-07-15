import { Archive, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import { useWfComponents } from './context'
import { HoldButton } from './hold-button'
import { Tooltip } from './tooltip'

// Icon-only archive control used across 007 toolbars. Click opens a dialog that
// spells out what's about to happen; confirming requires a deliberate press-and-
// hold (HoldButton) so archiving is never a one-click accident.

export function ArchiveButton({
  onConfirm,
  description,
  title = 'Archive',
  confirmLabel = 'Hold to archive',
}: {
  /** Fired once the hold-to-confirm completes. */
  onConfirm: () => void
  /** What's about to happen — shown in the dialog body. */
  description: ReactNode
  /** Tooltip + dialog heading. */
  title?: string
  confirmLabel?: string
}) {
  const { Button } = useWfComponents()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <>
      <Tooltip content={title} side="bottom">
        <button
          type="button"
          aria-label={title}
          onClick={() => setOpen(true)}
          className="inline-flex size-8 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800"
        >
          <Archive className="size-4" />
        </button>
      </Tooltip>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-lg border border-neutral-200 bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-3">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold">
                <Archive className="size-4 text-neutral-500" />
                {title}
              </h2>
              <button
                aria-label="Close"
                onClick={() => setOpen(false)}
                className="text-neutral-400 transition hover:text-neutral-700"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="px-5 py-4 text-sm leading-relaxed text-neutral-600">
              {description}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-neutral-200 px-5 py-3">
              <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <HoldButton
                size="md"
                tone="danger"
                title={confirmLabel}
                onHold={() => {
                  setOpen(false)
                  onConfirm()
                }}
              >
                <Archive className="size-4" />
                {confirmLabel}
              </HoldButton>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
