import { X } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'

// Shared dialog scaffolding extracted from the create/help/config dialogs: a
// full-screen backdrop that closes on click, a centered panel that swallows its
// own clicks, an optional titled header with a close button, an optional footer
// action bar, and (by default) Escape-to-close. Callers own the panel's width /
// height / layout via `panelClassName` and supply their body as `children`.

export type ModalProps = {
  open: boolean
  onClose: () => void
  /** Renders the standard header row (title + close button) when provided. */
  title?: ReactNode
  /** Full className for the inner panel — controls its width, height, layout. */
  panelClassName?: string
  /** Body content, rendered between the header and footer. */
  children: ReactNode
  /** Content for the standard bottom action bar; the bar is omitted when null. */
  footer?: ReactNode
  /** Close the modal when Escape is pressed. Defaults to true. */
  closeOnEsc?: boolean
}

export function Modal({
  open,
  onClose,
  title,
  panelClassName,
  children,
  footer,
  closeOnEsc = true,
}: ModalProps) {
  useEffect(() => {
    if (!open || !closeOnEsc) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, closeOnEsc])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div className={panelClassName} onClick={(e) => e.stopPropagation()}>
        {title != null ? (
          <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-3">
            <h2 className="text-sm font-semibold">{title}</h2>
            <button
              aria-label="Close"
              onClick={onClose}
              className="text-neutral-400 transition hover:text-neutral-700"
            >
              <X className="size-4" />
            </button>
          </div>
        ) : null}
        {children}
        {footer != null ? (
          <div className="flex justify-end gap-2 border-t border-neutral-200 px-5 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  )
}
