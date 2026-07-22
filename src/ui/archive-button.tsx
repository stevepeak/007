import { Archive } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { useWfComponents } from './context'
import { HoldButton } from './hold-button'
import { Modal } from './modal'
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

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={
          <span className="flex items-center gap-1.5">
            <Archive className="size-4 text-neutral-500" />
            {title}
          </span>
        }
        panelClassName="w-full max-w-md rounded-lg border border-neutral-200 bg-white shadow-xl"
      >
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
      </Modal>
    </>
  )
}
