import {
  Activity,
  Bot,
  Boxes,
  Target,
  ThumbsUp,
  Wrench,
  Workflow as WorkflowIcon,
  type LucideIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from './cn'

// Top-level navigation for the workflow tooling: one descriptive card per
// section. Purely presentational — the host owns routing and wires `onOpen(key)`
// to navigate. No data client / provider required.
//
// Two layouts, chosen by whether `children` (the operational dashboard) is
// passed. With content, the page is a two-column working surface: the cards
// collapse into a navigation rail on the LEFT — where a nav is looked for — and
// the dashboard takes the whole remaining width. Without it there is nothing to
// be secondary to, so the cards spread back out into the full-width grid.

/** Per-card hover accent. Full literal Tailwind class strings (v4 scans them). */
type WfHubAccent = {
  /** Applied to the card on hover: colored border + soft colored shadow. */
  card: string
  /** Applied to the icon chip on hover: illuminated tint + glow. */
  icon: string
}

export type WfHubSection = {
  key: string
  title: string
  description: string
  icon: LucideIcon
  /** Distinct hover color for this card. */
  accent?: WfHubAccent
  /** Renders the card muted + non-clickable (e.g. a not-yet-built section). */
  disabled?: boolean
  /** Small corner label, e.g. "Coming soon". */
  badge?: string
}

export const DEFAULT_WF_SECTIONS: WfHubSection[] = [
  {
    key: 'workflows',
    title: 'Workflows',
    description: 'Design and publish agent workflows as visual graphs.',
    icon: WorkflowIcon,
    accent: {
      card: 'hover:border-indigo-300 hover:shadow-lg hover:shadow-indigo-100',
      icon: 'group-hover:bg-indigo-100 group-hover:text-indigo-600 group-hover:shadow-md group-hover:shadow-indigo-200',
    },
  },
  {
    key: 'agents',
    title: 'Agents',
    description:
      'Configure reusable agents — model, tools, and tests in one place.',
    icon: Bot,
    accent: {
      card: 'hover:border-violet-300 hover:shadow-lg hover:shadow-violet-100',
      icon: 'group-hover:bg-violet-100 group-hover:text-violet-600 group-hover:shadow-md group-hover:shadow-violet-200',
    },
  },
  {
    key: 'tools',
    title: 'Tools',
    description: 'Browse the tools agents and workflows can call.',
    icon: Wrench,
    accent: {
      card: 'hover:border-emerald-300 hover:shadow-lg hover:shadow-emerald-100',
      icon: 'group-hover:bg-emerald-100 group-hover:text-emerald-600 group-hover:shadow-md group-hover:shadow-emerald-200',
    },
  },
  {
    key: 'runs',
    title: 'Runs',
    description: 'Inspect executions and their step-by-step traces.',
    icon: Activity,
    accent: {
      card: 'hover:border-sky-300 hover:shadow-lg hover:shadow-sky-100',
      icon: 'group-hover:bg-sky-100 group-hover:text-sky-600 group-hover:shadow-md group-hover:shadow-sky-200',
    },
  },
  {
    key: 'evals',
    title: 'Evals',
    description:
      'Test workflows and agents using different AI models to get more predictable outcomes.',
    icon: Target,
    accent: {
      card: 'hover:border-rose-300 hover:shadow-lg hover:shadow-rose-100',
      icon: 'group-hover:bg-rose-100 group-hover:text-rose-600 group-hover:shadow-md group-hover:shadow-rose-200',
    },
  },
  {
    key: 'models',
    title: 'Models',
    description:
      'Curate the AI models available to agents and evals — refresh provider catalogs and enable the ones you want.',
    icon: Boxes,
    accent: {
      card: 'hover:border-amber-300 hover:shadow-lg hover:shadow-amber-100',
      icon: 'group-hover:bg-amber-100 group-hover:text-amber-600 group-hover:shadow-md group-hover:shadow-amber-200',
    },
  },
  {
    key: 'feedback',
    title: 'Feedback',
    description:
      "What people thought of the AI's answers — triage thumbs up/down and comments, and acknowledge each once your team has acted on it.",
    icon: ThumbsUp,
    accent: {
      card: 'hover:border-teal-300 hover:shadow-lg hover:shadow-teal-100',
      icon: 'group-hover:bg-teal-100 group-hover:text-teal-600 group-hover:shadow-md group-hover:shadow-teal-200',
    },
  },
]

export type WfHubProps = {
  sections?: WfHubSection[]
  /** Called with a section's `key` when its card is activated. */
  onOpen: (key: string) => void
  className?: string
  /**
   * The page's main content — where `WfApp` mounts the operational dashboard.
   * Passing it switches the hub to the two-column layout described above.
   * Anything passed here supplies its own data; the hub itself stays
   * presentational and needs no provider.
   */
  children?: ReactNode
}

export function WfHub({
  sections = DEFAULT_WF_SECTIONS,
  onOpen,
  className,
  children,
}: WfHubProps) {
  const asRail = children != null
  return (
    <div className={cn('w-full p-6', className)}>
      <div
        className={cn(
          asRail &&
            'grid grid-cols-1 items-start gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]',
        )}
      >
        {/* Rail first in the DOM so it lands in the left column; stacked (below
            lg) the dashboard is the headline, so the nav drops beneath it. */}
        <nav
          aria-label="Sections"
          className={cn(
            asRail
              ? 'order-last flex flex-col gap-2 lg:order-none'
              : 'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3',
          )}
        >
          {sections.map((section) => {
            const Icon = section.icon
            return (
              <button
                key={section.key}
                type="button"
                disabled={section.disabled}
                onClick={() => {
                  if (!section.disabled) onOpen(section.key)
                }}
                className={cn(
                  'group flex flex-col items-start rounded-xl border border-neutral-200 bg-white text-left transition duration-200',
                  asRail ? 'gap-1.5 p-3.5' : 'gap-3 p-5',
                  section.disabled
                    ? 'cursor-not-allowed opacity-60'
                    : (section.accent?.card ??
                        'hover:border-neutral-300 hover:shadow-lg'),
                )}
              >
                <div
                  className={cn(
                    'flex w-full items-center',
                    asRail ? 'gap-2.5' : 'gap-3',
                  )}
                >
                  <span
                    className={cn(
                      'flex items-center justify-center rounded-lg bg-neutral-100 text-neutral-600 transition duration-200',
                      asRail ? 'size-8' : 'size-10',
                      !section.disabled && section.accent?.icon,
                    )}
                  >
                    <Icon className={asRail ? 'size-4' : 'size-5'} />
                  </span>
                  <span
                    className={cn(
                      'font-medium text-neutral-900',
                      asRail ? 'text-sm' : 'text-base',
                    )}
                  >
                    {section.title}
                  </span>
                  {section.badge ? (
                    <span className="ml-auto rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-500">
                      {section.badge}
                    </span>
                  ) : null}
                </div>
                {/* In the rail the description is supporting detail, not the
                    pitch — clamped so one long section blurb can't push the
                    whole nav out of view. */}
                <p
                  className={cn(
                    'text-neutral-500',
                    asRail ? 'line-clamp-2 text-xs' : 'text-sm',
                  )}
                >
                  {section.description}
                </p>
              </button>
            )
          })}
        </nav>
        {/* min-w-0 so a wide chart can shrink instead of forcing the grid open. */}
        {asRail ? <div className="min-w-0">{children}</div> : null}
      </div>
    </div>
  )
}
