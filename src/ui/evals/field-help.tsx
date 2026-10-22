import { HelpCircle } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { Modal } from '../modal'

// Small "(?)" affordance next to a field label that opens a Modal explaining
// what the field does. Owns its own open state so it can be dropped inline.
export function FieldHelp({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        aria-label={`About ${title}`}
        onClick={() => setOpen(true)}
        className="inline-flex size-4 items-center justify-center rounded-full text-neutral-400 transition hover:text-neutral-700"
      >
        <HelpCircle className="size-3.5" />
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        panelClassName="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-lg border border-neutral-200 bg-white shadow-xl"
      >
        <div className="space-y-3 px-5 py-5 text-sm leading-relaxed text-neutral-600">
          {children}
        </div>
      </Modal>
    </>
  )
}
