import { X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import { cn } from './cn'

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
                <span aria-hidden>✨</span>
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

            <div className="space-y-3 px-5 py-4 text-sm leading-relaxed text-neutral-600">
              {children}
            </div>

            <div className="border-t border-neutral-200 px-5 py-2.5">
              <p className="text-xs text-neutral-400">
                Idea placeholder — not built yet. We’ll refine this after
                feedback.
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
