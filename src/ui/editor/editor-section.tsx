import { type LucideIcon } from 'lucide-react'
import { type ReactNode } from 'react'

// A titled card wrapping one part of an editor. Each concern (Prompt, Tools,
// Sub-agents, Output, Settings, Recent calls) gets its own bordered section with
// an icon, heading, and one-line description so the page reads as distinct steps
// rather than a flat stack of labels. Shared by the agent editor and its
// sibling panels.
export function EditorSection({
  icon: Icon,
  title,
  description,
  actions,
  children,
}: {
  icon: LucideIcon
  title: string
  description?: ReactNode
  /** Optional controls pinned to the right of the header (filters, toggles). */
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="rounded-lg border border-neutral-200 bg-white">
      <header className="flex items-start gap-3 rounded-t-lg border-b border-neutral-100 bg-neutral-50/60 px-4 py-3">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-white text-neutral-500 ring-1 ring-neutral-200">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <h3 className="text-sm font-medium text-neutral-800">{title}</h3>
          {description ? (
            <p className="text-xs text-neutral-400">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </header>
      <div className="space-y-4 p-4">{children}</div>
    </section>
  )
}
