import {
  Activity,
  Bot,
  Boxes,
  Target,
  Wrench,
  Workflow as WorkflowIcon,
  type LucideIcon,
} from 'lucide-react'

import { cn } from './cn'

// Top-level navigation hub for the workflow tooling: a 2×N grid of descriptive
// cards, one per section. Purely presentational — the host owns routing and
// wires `onOpen(key)` to navigate. No data client / provider required.

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
]

export type WfHubProps = {
  sections?: WfHubSection[]
  /** Called with a section's `key` when its card is activated. */
  onOpen: (key: string) => void
  title?: string
  subtitle?: string
  className?: string
}

export function WfHub({
  sections = DEFAULT_WF_SECTIONS,
  onOpen,
  subtitle = 'Build, run, and evaluate AI workflows.',
  className,
}: WfHubProps) {
  return (
    <div className={cn('mx-auto max-w-4xl p-6', className)}>
      <div className="mb-8 flex flex-col items-center">
        {/* Placeholder brand image — swap in real artwork later. */}
        <div
          aria-hidden
          className="h-[120px] w-[200px] rounded-lg border border-dashed border-neutral-300 bg-neutral-50"
        />
        <p className="mt-3 max-w-md text-center text-sm text-neutral-500">
          {subtitle}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
                'group flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-white p-5 text-left transition duration-200',
                section.disabled
                  ? 'cursor-not-allowed opacity-60'
                  : (section.accent?.card ??
                      'hover:border-neutral-300 hover:shadow-lg'),
              )}
            >
              <div className="flex w-full items-center gap-3">
                <span
                  className={cn(
                    'flex size-10 items-center justify-center rounded-lg bg-neutral-100 text-neutral-600 transition duration-200',
                    !section.disabled && section.accent?.icon,
                  )}
                >
                  <Icon className="size-5" />
                </span>
                <span className="text-base font-medium text-neutral-900">
                  {section.title}
                </span>
                {section.badge ? (
                  <span className="ml-auto rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-500">
                    {section.badge}
                  </span>
                ) : null}
              </div>
              <p className="text-sm text-neutral-500">{section.description}</p>
            </button>
          )
        })}
      </div>
    </div>
  )
}
