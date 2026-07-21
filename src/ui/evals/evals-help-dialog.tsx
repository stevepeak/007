import { FlaskConical, Layers, ListChecks, Target } from 'lucide-react'
import { type ReactNode } from 'react'

import { Modal } from '../modal'

// Explains the Evals → Goals → Samples → Tests hierarchy and why it exists.
// Opened from the (?) button on the Evals catalog. Purely informational.

export type EvalsHelpDialogProps = {
  open: boolean
  onClose: () => void
}

export function EvalsHelpDialog({ open, onClose }: EvalsHelpDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="How Evals work"
      panelClassName="max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-lg border border-neutral-200 bg-white shadow-xl"
    >
        <div className="space-y-5 px-5 py-5">
          <p className="text-sm leading-relaxed text-neutral-600">
            Evals let you prove your agents and workflows still do the right
            thing — before your users find out they don't. Every change to an
            agent or workflow can quietly shift behavior; Evals turn "seems fine"
            into a repeatable, measurable pass/fail with a quality score, run
            safely in simulation so no real emails send and no real data changes.
          </p>

          <div className="space-y-3">
            <Level
              icon={<Layers className="size-4" />}
              accent="bg-rose-50 text-rose-600"
              title="Goal"
              subtitle="An outcome to guarantee"
            >
              A named suite around one goal — e.g. “Escalation Policy” or
              “Document Categorization”. It groups the scenarios that prove that
              goal holds, and you re-run it any time you touch a related agent or
              workflow.
            </Level>

            <Level
              icon={<FlaskConical className="size-4" />}
              accent="bg-violet-50 text-violet-600"
              title="Sample"
              subtitle="One concrete scenario"
            >
              A real-world case: a <strong>Given</strong> (the starting inputs),{' '}
              <strong>what runs</strong> (an agent or a workflow), and the{' '}
              <strong>Tests</strong> it must satisfy. Samples pin behavior to
              actual situations instead of vibes.
            </Level>

            <Level
              icon={<ListChecks className="size-4" />}
              accent="bg-emerald-50 text-emerald-600"
              title="Test"
              subtitle="One thing that must be true"
            >
              A single assertion on the run — <strong>binary</strong> (a tool was
              called, a node ran, the output matches) or <strong>scored</strong>{' '}
              (a judge rates quality from 0–1). Binary tests catch regressions;
              scored tests measure how <em>good</em> the answer was.
            </Level>
          </div>

          <div className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3">
            <div className="mb-1 flex items-center gap-1.5 text-sm font-medium text-neutral-800">
              <Target className="size-4 text-neutral-500" />
              What you get
            </div>
            <ul className="space-y-1 text-sm text-neutral-600">
              <li>
                <strong>Confidence to ship</strong> — regressions surface the
                moment you re-run, not in production.
              </li>
              <li>
                <strong>Comparable scores</strong> — the judge-only score lets
                you rank models and track quality over time.
              </li>
              <li>
                <strong>Safe by default</strong> — runs execute simulated under
                the eval tenant, so testing never causes real side effects.
              </li>
            </ul>
          </div>
        </div>
    </Modal>
  )
}

function Level({
  icon,
  accent,
  title,
  subtitle,
  children,
}: {
  icon: ReactNode
  accent: string
  title: string
  subtitle: string
  children: ReactNode
}) {
  return (
    <div className="flex gap-3">
      <span
        className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${accent}`}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-neutral-900">
            {title}
          </span>
          <span className="text-xs text-neutral-400">{subtitle}</span>
        </div>
        <p className="mt-0.5 text-sm leading-relaxed text-neutral-600">
          {children}
        </p>
      </div>
    </div>
  )
}
