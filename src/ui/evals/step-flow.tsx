import type { ReactNode } from 'react'

// A top-to-bottom flow of full-width cards — one per step of "choose something →
// configure the next thing". Every card is always open: the header names the step
// (with an optional right-aligned accessory — a planned-⚡ marker, meta label, or
// action), and the body holds that step's editor.

export type Step = {
  key: string
  /** Card header label. */
  title: string
  /** Right-aligned header accessory. */
  aside?: ReactNode
  content: ReactNode
}

export function StepFlow({ steps }: { steps: Step[] }) {
  return (
    <div className="space-y-3">
      {steps.map((s) => (
        <section
          key={s.key}
          className="overflow-hidden rounded-lg border border-neutral-200"
        >
          <div className="flex items-center gap-1 border-b border-neutral-100 bg-neutral-50 px-4 py-2">
            <span className="text-sm font-medium text-neutral-700">
              {s.title}
            </span>
            {s.aside ? (
              <div className="ml-auto flex items-center gap-2">{s.aside}</div>
            ) : null}
          </div>
          <div className="p-4">{s.content}</div>
        </section>
      ))}
    </div>
  )
}
