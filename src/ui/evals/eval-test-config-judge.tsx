import { HelpCircle } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'

import type { EvalCheck } from '../../server/protocol'
import { useWfComponents } from '../context'
import { ModelSelect } from '../editor/model-select'
import { useModels } from '../hooks'
import { Modal } from '../modal'
import { useCommittedField } from '../use-committed-field'

// ── Scored (judge) config ────────────────────────────────────────────────────

export function JudgeConfig({
  check,
  persist,
}: {
  check: Extract<EvalCheck, { type: 'llm_judge' }>
  persist: (next: EvalCheck) => void
}) {
  const { Input, Label, Textarea } = useWfComponents()
  const rubricField = useCommittedField(check.rubric, (rubric) =>
    persist({ ...check, rubric }),
  )
  // Optional JSON path pinning the judge to one output field; blank = whole output.
  const pathField = useCommittedField(check.path ?? '', (path) =>
    persist({ ...check, path: path.trim() || undefined }),
  )

  // The judge model is required, so keep one selected: as soon as the model list
  // loads, seed an empty selection with the first available model.
  const models = useModels()
  useEffect(() => {
    if (check.modelId) return
    const first = models.data?.[0]?.id
    if (first) persist({ ...check, modelId: first })
  }, [check, models.data, persist])

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label>Judge model</Label>
        <ModelSelect
          value={check.modelId ?? ''}
          onChange={(modelId) => persist({ ...check, modelId })}
        />
      </div>
      <div className="space-y-1">
        <Label>Rubric</Label>
        <Textarea
          rows={3}
          value={rubricField.value}
          placeholder="What should the judge reward or penalize?"
          onChange={(e) => rubricField.onChange(e.target.value)}
          onBlur={rubricField.onBlur}
        />
      </div>
      <div className="space-y-1">
        <div className="flex items-center gap-1">
          <Label>Output path (optional)</Label>
          <FieldHelp title="Output path">
            <p>
              Pin the judge to a single field of the run output instead of the
              whole thing. Use a dot/bracket path like{' '}
              <strong>docMeta.parties</strong> or <strong>items[0].name</strong>.
            </p>
            <p>
              Leave it <strong>blank</strong> to grade the entire output. Set it
              when your rubric is about one known value — the judge then sees
              only that value, so unrelated fields can’t distract or dilute it.
            </p>
          </FieldHelp>
        </div>
        <Input
          value={pathField.value}
          placeholder="blank = whole output — e.g. docMeta.parties"
          onChange={(e) => pathField.onChange(e.target.value)}
          onBlur={pathField.onBlur}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <Label>Threshold</Label>
            <FieldHelp title="Threshold">
              <p>
                The pass/fail cutoff for this scored test. The judge rates the
                run on a <strong>0–1</strong> scale against your rubric; a score
                at or above the threshold <strong>passes</strong>, below it{' '}
                <strong>fails</strong>.
              </p>
              <p>
                Raise it to demand higher-quality answers (stricter), lower it
                to be more forgiving. <strong>0.7</strong> is a sensible default
                — roughly “clearly good, minor flaws OK”. The threshold only
                decides pass/fail; the raw 0–1 score still feeds the weighted
                quality score.
              </p>
            </FieldHelp>
          </div>
          <Input
            type="number"
            step="0.05"
            min="0"
            max="1"
            value={String(check.threshold ?? 0.7)}
            onChange={(e) =>
              persist({ ...check, threshold: Number(e.target.value) })
            }
          />
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <Label>Weight</Label>
            <FieldHelp title="Weight">
              <p>
                How much this test counts toward the sample’s overall quality
                score. Every scored test’s 0–1 judge score is combined as a{' '}
                <strong>weighted mean</strong>, and weight scales this test’s
                share of that mean relative to the others.
              </p>
              <p>
                A weight of <strong>2</strong> makes a test count twice as much
                as a weight-<strong>1</strong> test; <strong>0.5</strong> counts
                half. Leave it at the default <strong>1</strong> to weigh all
                scored tests equally. Weight affects the aggregate score only —
                not whether this individual test passes.
              </p>
            </FieldHelp>
          </div>
          <Input
            type="number"
            step="0.5"
            min="0"
            value={String(check.weight ?? 1)}
            onChange={(e) =>
              persist({ ...check, weight: Number(e.target.value) })
            }
          />
        </div>
      </div>
      <p className="text-xs text-neutral-400">
        Scored tests contribute to the goal/sample score; the threshold maps the
        0–1 judge score to pass/fail, weight scales its share of the mean.
      </p>
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
