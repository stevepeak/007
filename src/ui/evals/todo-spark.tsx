import { X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

// A ⚡ marker for planned-but-unbuilt UX. Click it to open a dialog describing
// what we want that spot to become. Purely a design placeholder — nothing here
// ships behavior, it just documents intent inline where the feature will live.

export type TodoSparkProps = {
  /** Short name of the planned feature (dialog heading). */
  title: string
  /** The description of what we want to accomplish. */
  children: ReactNode
}

export function TodoSpark({ title, children }: TodoSparkProps) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        aria-label={`Planned: ${title}`}
        title="Planned — click for details"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen(true)
        }}
        className="inline-flex size-5 items-center justify-center rounded text-sm leading-none transition hover:bg-amber-100"
      >
        ⚡
      </button>
      <TodoDialog open={open} onClose={() => setOpen(false)} title={title}>
        {children}
      </TodoDialog>
    </>
  )
}

function TodoDialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-neutral-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-3">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <span>⚡</span> Planned
          </h2>
          <button
            aria-label="Close"
            onClick={onClose}
            className="text-neutral-400 transition hover:text-neutral-700"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="px-5 py-4">
          <h3 className="text-sm font-semibold text-neutral-900">{title}</h3>
          <div className="mt-2 space-y-2 text-sm leading-relaxed text-neutral-600">
            {children}
          </div>
        </div>
        <div className="border-t border-neutral-200 px-5 py-2.5 text-xs text-neutral-400">
          Not built yet — captured as a TODO.
        </div>
      </div>
    </div>
  )
}
