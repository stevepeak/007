import { useEffect } from 'react'

import { DEFAULT_DECISION_THRESHOLD, type JsonSchema } from '../../engine'
import type { EvalCheck } from '../../server/protocol'
import { useWfComponents } from '../context'
import { useDecisionModels } from '../hooks-models'
import { useCommittedField } from '../use-committed-field'

import { FieldHelp } from './eval-check-config-judge'
import { outputPathOptions } from './fields'

// ── Calibrated (decision) judge config ───────────────────────────────────────
//
// The same three decisions as the LLM judge — who grades, what it looks at, what
// has to hold — plus the one this check exists for: WHERE THE LINE IS.
//
// An LLM judge is asked for a verdict and then for its confidence in that
// verdict, which is a guess about a guess. A decision model answers with a
// probability and this panel applies the cut, so a borderline row reads as 0.52
// instead of as a pass with a cheerful 8/10 beside it. That is the whole trade,
// and the threshold field is where the author takes hold of it.

export function DecisionJudgeConfig({
  check,
  persist,
  outputSchema,
}: {
  check: Extract<EvalCheck, { type: 'decision_judge' }>
  persist: (next: EvalCheck) => void
  /** The target agent's output contract — the source of the path options. */
  outputSchema?: JsonSchema | null
}) {
  const { Input, Label, Textarea } = useWfComponents()
  const rubricField = useCommittedField(check.rubric, (rubric) => {
    return persist({ ...check, rubric })
  })
  const pathField = useCommittedField(check.path ?? '', (path) => {
    return persist({ ...check, path: path.trim() || undefined })
  })

  // Keep a decider selected, the same way the LLM judge keeps a model: the check
  // cannot grade without one, so seed the first as soon as the list loads.
  const models = useDecisionModels()
  useEffect(() => {
    if (check.modelId) return
    const first = models.data?.[0]?.id
    if (first) persist({ ...check, modelId: first })
  }, [check, models.data, persist])

  const chosen = models.data?.find((m) => m.id === check.modelId)
  const pathOptions = outputPathOptions(outputSchema)
  const showsCustom = Boolean(
    pathOptions &&
      check.path &&
      !pathOptions.some((o) => o.value === check.path),
  )
  const selectedField = pathOptions?.find((o) => o.value === (check.path ?? ''))

  if (!models.isLoading && (models.data ?? []).length === 0) {
    return (
      <p className="text-sm text-neutral-500">
        This deployment has no decision provider wired up, so a calibrated judge
        cannot grade. Use a <strong>Judge</strong> check instead, or wire{' '}
        <code>WfSdkConfig.getDecider</code>.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <Label>Decider</Label>
            <FieldHelp title="Decider">
              <p>
                The decision model that grades this check. Unlike a chat judge it
                answers with a probability rather than a written verdict, so the
                result carries how close the call was instead of a self-reported
                confidence.
              </p>
            </FieldHelp>
          </div>
          <select
            value={check.modelId ?? ''}
            onChange={(e) => persist({ ...check, modelId: e.target.value })}
            className="h-9 w-full rounded-md border border-neutral-300 bg-transparent px-2 text-sm outline-none focus:border-neutral-500"
          >
            {(models.data ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {m.calibrated === false ? ' (emulated)' : ''}
              </option>
            ))}
          </select>
          {chosen?.calibrated === false ? (
            <p className="text-xs text-neutral-400">
              Emulated on a chat model — treat the threshold as rough.
            </p>
          ) : null}
        </div>

        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <Label>Passes above</Label>
            <FieldHelp title="Passes above">
              <p>
                The probability at or above which this check passes. 0.5 treats
                the judgment as a simple yes/no; raise it when you would rather
                see a borderline row fail than pass.
              </p>
              <p>
                The decider never sees this number — it reports how likely the
                statement is, and the line is yours to draw. That is what lets
                you retune a suite without re-running it against a different
                question.
              </p>
            </FieldHelp>
          </div>
          <Input
            type="number"
            min={0}
            max={1}
            step={0.05}
            placeholder={String(DEFAULT_DECISION_THRESHOLD)}
            value={check.threshold ?? ''}
            onChange={(e) => {
              const raw = e.target.value
              return persist({
                ...check,
                threshold: raw === '' ? undefined : Number(raw),
              })
            }}
          />
        </div>

        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <Label>Output field</Label>
            <FieldHelp title="Output field">
              <p>
                Pin the judgment to a single field of the target’s output instead
                of the whole thing, so unrelated fields can’t dilute it.
              </p>
            </FieldHelp>
          </div>
          {pathOptions ? (
            <select
              value={check.path ?? ''}
              onChange={(e) => {
                return persist({ ...check, path: e.target.value || undefined })
              }}
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
              placeholder="blank = whole output"
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
          rows={3}
          value={rubricField.value}
          placeholder="e.g. The answer cites the statute that actually governs the question asked."
          onChange={(e) => rubricField.onChange(e.target.value)}
          onBlur={rubricField.onBlur}
        />
        {/* The phrasing matters more here than for a chat judge: this text is
            put to the model AS the question, with no surrounding instructions to
            recover from a statement that isn't one. */}
        <p className="text-xs text-neutral-400">
          Phrased so that “yes” means the row passed. It is asked as the question
          itself, not wrapped in a grading prompt.
        </p>
      </div>
    </div>
  )
}
