import { ChevronDown, type LucideIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { cn } from '../cn'

// A titled card wrapping one part of an editor. Each concern (Prompt, Tools,
// Sub-agents, Output, Settings, Recent calls) gets its own bordered section with
// an icon, heading, and one-line description so the page reads as distinct steps
// rather than a flat stack of labels. Shared by the agent editor and its
// sibling panels.
//
// A `collapsible` section can start folded away — used for concerns that are
// empty and optional (an agent with no sub-agents shouldn't pay a screenful of
// pickers and guardrails for a feature it isn't using). The header stays
// visible so the concern is still discoverable, and one click opens it.
export function EditorSection({
  icon: Icon,
  title,
  description,
  badge,
  actions,
  collapsible = false,
  defaultCollapsed = false,
  children,
}: {
  icon: LucideIcon
  title: string
  description?: ReactNode
  /**
   * Short status pinned beside the title — e.g. "Not applicable" for a section
   * whose controls are all inert. Stays visible while collapsed, so a folded
   * section still says why it's folded.
   */
  badge?: ReactNode
  /** Optional controls pinned to the right of the header (filters, toggles). */
  actions?: ReactNode
  /** Let the header fold the body away. */
  collapsible?: boolean
  /**
   * Whether the section should be folded while the author hasn't said
   * otherwise. Tracked live, not just on mount: a Budget section folded because
   * the agent had nothing to call unfolds itself the moment a tool is attached.
   * The first click on the header takes ownership and the manual choice sticks.
   */
  defaultCollapsed?: boolean
  children: ReactNode
}) {
  // null = still following `defaultCollapsed`; a boolean = the author's choice.
  const [override, setOverride] = useState<boolean | null>(null)
  const collapsed = collapsible && (override ?? defaultCollapsed)
  const open = !collapsed

  const header = (
    <>
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-white text-neutral-500 ring-1 ring-neutral-200">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <h3 className="flex items-center gap-2 text-sm font-medium text-neutral-800">
          {title}
          {badge ? (
            <span className="rounded bg-neutral-200/70 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-neutral-500">
              {badge}
            </span>
          ) : null}
        </h3>
        {description ? (
          <p className="text-xs text-neutral-400">{description}</p>
        ) : null}
      </div>
      {collapsible ? (
        <ChevronDown
          className={cn(
            'mt-0.5 size-4 shrink-0 text-neutral-400 transition-transform',
            !open && '-rotate-90',
          )}
        />
      ) : null}
    </>
  )

  return (
    <section className="rounded-lg border border-neutral-200 bg-white">
      <header
        className={cn(
          'flex items-start gap-3 rounded-t-lg bg-neutral-50/60 px-4 py-3',
          open && 'border-b border-neutral-100',
          !open && 'rounded-b-lg',
        )}
      >
        {collapsible ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOverride(open)}
            className="flex min-w-0 flex-1 items-start gap-3 text-left"
          >
            {header}
          </button>
        ) : (
          header
        )}
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </header>
      {open ? <div className="space-y-4 p-4">{children}</div> : null}
    </section>
  )
}
