import { useState, type ReactNode } from 'react'

import { cn } from './cn'
import { Modal } from './modal'

// A small ✨ marker you can drop anywhere in the UI to stash an inspirational,
// not-yet-built idea. Clicking the sparkle opens a lightweight dialog that
// describes what this spot could become — a placeholder we can gather feedback
// on and flesh out later. It ships no behavior of its own; it's a note to self
// rendered in place so the idea lives next to the thing it's about.

export type IdeaSparkProps = {
  /** Short headline for the idea, shown as the dialog title. */
  title: string
  /** The pitch — what this spot could do once built. */
  children: ReactNode
  /** Tooltip / aria hint on the sparkle itself. Defaults to the title. */
  hint?: string
  className?: string
}

export function IdeaSpark({ title, children, hint, className }: IdeaSparkProps) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        aria-label={hint ?? `Idea: ${title}`}
        title={hint ?? title}
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
        className={cn(
          'inline-flex items-center leading-none opacity-60 transition hover:scale-110 hover:opacity-100',
          className,
        )}
      >
        <span aria-hidden className="text-sm">
          ✨
        </span>
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={
          <span className="flex items-center gap-1.5">
            <span aria-hidden>✨</span>
            {title}
          </span>
        }
        panelClassName="w-full max-w-md rounded-lg border border-neutral-200 bg-white shadow-xl"
      >
        <div className="space-y-3 px-5 py-4 text-sm leading-relaxed text-neutral-600">
          {children}
        </div>

        <div className="border-t border-neutral-200 px-5 py-2.5">
          <p className="text-xs text-neutral-400">
            Idea placeholder — not built yet. We’ll refine this after
            feedback.
          </p>
        </div>
      </Modal>
    </>
  )
}
