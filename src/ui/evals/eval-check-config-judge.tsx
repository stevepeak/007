import { HelpCircle } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import type { JsonSchema } from '../../engine'
import type { EvalCheck } from '../../server/protocol'
import { useWfComponents } from '../context'
import { Modal } from '../modal'
import { useCommittedField } from '../use-committed-field'

import { OutputPathSelect, schemaPathOptions } from './fields'

// ── Scored (judge) config ────────────────────────────────────────────────────
//
// Two settings: WHAT it looks at (a field of the target's output, or all of
// it) and WHAT HAS TO HOLD. WHO grades is not a check setting — the judge model
// is picked once per run in the launch dialog, so one report has one judge.
//
// It's labelled "What must be true" rather than "Rubric" — same word the help
// dialog uses for a Check itself. "Rubric" is grading jargon, and worse, it
// invites a list: a rubric is a table of dimensions, and a judge handed several
// of them hedges across all of them. A singular label asks for one statement,
// which is the whole design, and does it without a note underneath explaining
// that it did. The stored field stays `rubric` — the same UI-vs-code vocabulary
// split as Goal/Sample vs set/row.

export function JudgeConfig({
  check,
  persist,
  outputSchema,
}: {
  check: Extract<EvalCheck, { type: 'llm_judge' }>
  persist: (next: EvalCheck) => void
  /** The target agent's output contract — the source of the path options. */
  outputSchema?: JsonSchema | null
}) {
  const { Label, Textarea } = useWfComponents()
  const rubricField = useCommittedField(check.rubric, (rubric) => {
    return persist({ ...check, rubric })
  })

  const pathOptions = schemaPathOptions(outputSchema)
  const selectedField = pathOptions?.find((o) => o.value === (check.path ?? ''))

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <Label>Output field</Label>
            <FieldHelp title="Output field">
              <p>
                Pin the judge to a single field of the agent’s output instead
                of the whole thing. The options are the fields the agent
                actually declares, so a check can’t end up aimed at a field that
                will never be there.
              </p>
              <p>
                Leave it on <strong>Entire output</strong> to grade everything.
                Pin it when what you’re asserting is about one known value — the
                judge then sees only that value, so unrelated fields can’t
                distract or dilute it.
              </p>
            </FieldHelp>
          </div>
          {/* A workflow target has no single declared output shape, so it
              gets the free-form path box instead of the dropdown. */}
          <OutputPathSelect
            value={check.path}
            options={pathOptions}
            onSelect={(path) => persist({ ...check, path })}
            placeholder="blank = whole output — e.g. docMeta.recipients"
          />
          {selectedField?.description ? (
            <p className="text-xs text-neutral-400">
              {selectedField.description}
            </p>
          ) : null}
        </div>
      </div>

      <div className="space-y-1">
        <Label>What must be true</Label>
        <Textarea
          rows={4}
          value={rubricField.value}
          placeholder="e.g. The answer cites the policy section that actually applies to the question asked."
          onChange={(e) => rubricField.onChange(e.target.value)}
          onBlur={rubricField.onBlur}
        />
      </div>
    </div>
  )
}

// Small "(?)" affordance next to a field label that opens a Modal explaining
// what the field does. Owns its own open state so it can be dropped inline.
// Exported for the calibrated-judge panel next door, which asks the same kind of
// per-field question and should not grow a second one that drifts.
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
