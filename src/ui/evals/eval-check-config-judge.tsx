import { HelpCircle } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'

import type { JsonSchema } from '../../engine'
import type { ModelCapabilities } from '../../engine/config'
import type { EvalCheck } from '../../server/protocol'
import { useWfComponents } from '../context'
import { ModelSelect } from '../editor/model-select'
import { useModels } from '../hooks'
import { Modal } from '../modal'
import { unmetRequirements } from '../model-capabilities'
import { useCommittedField } from '../use-committed-field'

import { outputPathOptions } from './fields'

// A judge grades by emitting a JSON verdict (`generateObject` in eval/grade),
// so a model that can't do structured output can't be a judge at all. Rather
// than hide those models — which reads as "my provider is missing" — the picker
// shows them greyed out with the reason.
const JUDGE_REQUIREMENTS: ModelCapabilities = { structuredOutput: true }

// ── Scored (judge) config ────────────────────────────────────────────────────
//
// Three settings, in the order they're decided: WHO grades (the model), WHAT it
// looks at (a field of the target's output, or all of it), and WHAT HAS TO HOLD.
// The last one gets the full width below because it's the only one that's
// written rather than picked.
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
  const { Input, Label, Textarea } = useWfComponents()
  const rubricField = useCommittedField(check.rubric, (rubric) =>
    persist({ ...check, rubric }),
  )
  // Only reached for a workflow target, whose output has no single declared
  // shape to offer — an agent target picks from a dropdown instead.
  const pathField = useCommittedField(check.path ?? '', (path) =>
    persist({ ...check, path: path.trim() || undefined }),
  )

  // The judge model is required, so keep one selected: as soon as the model list
  // loads, seed an empty selection with the first model that can actually judge.
  const models = useModels()
  useEffect(() => {
    if (check.modelId) return
    const first = models.data?.find(
      (m) => unmetRequirements(m, JUDGE_REQUIREMENTS).length === 0,
    )?.id
    if (first) persist({ ...check, modelId: first })
  }, [check, models.data, persist])

  const pathOptions = outputPathOptions(outputSchema)
  // Preserve a stored path the schema doesn't declare (a nested path, or a
  // field the agent has since dropped) as its own option, so switching targets
  // never silently repoints the judge at the whole output.
  const showsCustom = Boolean(
    pathOptions && check.path && !pathOptions.some((o) => o.value === check.path),
  )
  const selectedField = pathOptions?.find((o) => o.value === (check.path ?? ''))

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <Label>Model</Label>
            <FieldHelp title="Model">
              <p>
                The model that does the grading. A judge has to return a
                structured verdict — a pass/fail with a reason — so models that
                don’t support structured output can’t be picked. They’re still
                listed, greyed out with the reason, so it’s clear they exist and
                why they’re unavailable.
              </p>
            </FieldHelp>
          </div>
          <ModelSelect
            value={check.modelId ?? ''}
            onChange={(modelId) => persist({ ...check, modelId })}
            requirements={JUDGE_REQUIREMENTS}
          />
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <Label>Output field</Label>
            <FieldHelp title="Output field">
              <p>
                Pin the judge to a single field of the target’s output instead of
                the whole thing. The options are the fields the agent actually
                declares, so a check can’t end up aimed at a field that will
                never be there.
              </p>
              <p>
                Leave it on <strong>Entire output</strong> to grade everything.
                Pin it when what you’re asserting is about one known value — the
                judge then sees only that value, so unrelated fields can’t
                distract or dilute it.
              </p>
            </FieldHelp>
          </div>
          {pathOptions ? (
            <select
              value={check.path ?? ''}
              onChange={(e) =>
                persist({ ...check, path: e.target.value || undefined })
              }
              className="h-9 w-full rounded-md border border-neutral-300 bg-transparent px-2 text-sm outline-none focus:border-neutral-500"
            >
              <option value="">Entire output</option>
              {pathOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                  {o.type ? ` · ${o.type}` : ''}
                </option>
              ))}
              {showsCustom ? (
                <option value={check.path}>{check.path} (custom)</option>
              ) : null}
            </select>
          ) : (
            <Input
              value={pathField.value}
              placeholder="blank = whole output — e.g. docMeta.parties"
              onChange={(e) => pathField.onChange(e.target.value)}
              onBlur={pathField.onBlur}
              className="font-mono text-xs"
            />
          )}
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
          placeholder="e.g. The answer cites the statute that actually governs the question asked."
          onChange={(e) => rubricField.onChange(e.target.value)}
          onBlur={rubricField.onBlur}
        />
      </div>
    </div>
  )
}

// Small "(?)" affordance next to a field label that opens a Modal explaining
// what the field does. Owns its own open state so it can be dropped inline.
function FieldHelp({
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
