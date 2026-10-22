import { useState } from 'react'

import { DEFAULT_DECISION_THRESHOLD, type JsonSchema } from '../../engine'
import type { CheckResult, EvalCheck } from '../../server/protocol'
import { useWfComponents } from '../context'
import { Segmented, type SegmentedOption } from '../filters'
import { usePreviewJudgeCheck } from '../hooks'
import { useDecisionModels } from '../hooks-models'
import { useCommittedField } from '../use-committed-field'

import { FieldHelp } from './field-help'
import { OutputPathSelect, schemaPathOptions } from './fields'
import { ProbabilityBar } from './run-report/atoms'

// ── Judge config ─────────────────────────────────────────────────────────────
//
// What the judge looks at (a field of the target's output, or all of it), the
// question it is asked, the answer shape, and WHERE THE LINE IS. The decision
// model is picked once per run on the launch page, not here.
//
// Every answer shape reduces to one probability — that the row passed — so the
// threshold means the same thing on all three: p(yes) for a yes/no, the mass on
// the expected options for a category, the mass at or above the minimum level
// for a scale.

type JudgeCheck = Extract<EvalCheck, { type: 'decision_judge' }>
type AnswerShape = NonNullable<JudgeCheck['answer']>

const ANSWER_SHAPES: SegmentedOption<AnswerShape>[] = [
  { value: 'boolean', label: 'Yes / No' },
  { value: 'category', label: 'Category' },
  { value: 'scale', label: 'Scale' },
]

export function DecisionJudgeConfig({
  check,
  persist,
  outputSchema,
}: {
  check: JudgeCheck
  persist: (next: EvalCheck) => void
  /** The target agent's output contract — the source of the path options. */
  outputSchema?: JsonSchema | null
}) {
  const { Input, Label, Textarea } = useWfComponents()
  const rubricField = useCommittedField(check.rubric, (rubric) => {
    return persist({ ...check, rubric })
  })
  const answer = check.answer ?? 'boolean'
  const choicesField = useCommittedField(
    (check.choices ?? []).join('\n'),
    (text) => {
      const choices = text
        .split('\n')
        .map((c) => c.trim())
        .filter(Boolean)
      return persist({
        ...check,
        choices,
        // A pass key that is no longer a choice would grade against nothing.
        expected: check.expected?.filter((k) => choices.includes(k)),
        minLevel:
          check.minLevel && choices.includes(check.minLevel)
            ? check.minLevel
            : undefined,
      })
    },
  )

  const models = useDecisionModels()
  const pathOptions = schemaPathOptions(outputSchema)
  const selectedField = pathOptions?.find((o) => o.value === (check.path ?? ''))

  if (!models.isLoading && (models.data ?? []).length === 0) {
    return (
      <p className="text-sm text-neutral-500">
        This deployment has no decision provider wired up, so a judge check
        cannot grade. Wire <code>WfSdkConfig.getDecider</code> — a chat model
        works too, through <code>createChatDecider</code>.
      </p>
    )
  }

  const choices = check.choices ?? []
  const setShape = (next: AnswerShape) => {
    if (next === answer) return
    // The question and the line carry across; what counts as a pass doesn't.
    return persist({
      type: 'decision_judge',
      rubric: check.rubric,
      path: check.path,
      threshold: check.threshold,
      ...(next === 'boolean' ? {} : { answer: next, choices }),
    })
  }
  const toggleExpected = (key: string) => {
    const expected = new Set(check.expected ?? [])
    if (expected.has(key)) expected.delete(key)
    else expected.add(key)
    return persist({
      ...check,
      expected: choices.filter((c) => expected.has(c)),
    })
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label>Question</Label>
        <Textarea
          rows={2}
          value={rubricField.value}
          placeholder={
            answer === 'boolean'
              ? 'e.g. Does the answer cite the policy section that applies to the question asked?'
              : answer === 'category'
                ? 'e.g. Which tone does the answer take?'
                : 'e.g. How complete is the answer?'
          }
          onChange={(e) => rubricField.onChange(e.target.value)}
          onBlur={rubricField.onBlur}
        />
        {/* This text is put to the model AS the question, with no surrounding
            instructions to recover from a statement that isn't one. */}
        <p className="text-xs text-neutral-400">
          {answer === 'boolean'
            ? 'Phrase it so “yes” means the row passed. Ask one thing — split a long rubric into several checks; they are asked together at no extra cost.'
            : 'Asked as the question itself, with the choices below as the possible answers.'}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
        <span>Answer</span>
        <Segmented
          variant="joined"
          label="Answer type"
          options={ANSWER_SHAPES}
          value={answer}
          onChange={setShape}
        />
      </div>

      {answer === 'boolean' ? null : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label>{answer === 'category' ? 'Options' : 'Levels, lowest first'}</Label>
            <Textarea
              rows={4}
              value={choicesField.value}
              placeholder={
                answer === 'category'
                  ? 'friendly\nneutral\ndefensive'
                  : 'poor\nfair\ngood\nexcellent'
              }
              onChange={(e) => choicesField.onChange(e.target.value)}
              onBlur={choicesField.onBlur}
            />
            <p className="text-xs text-neutral-400">One per line.</p>
          </div>
          <div className="space-y-1">
            <Label>{answer === 'category' ? 'Passing options' : 'Passes from'}</Label>
            {choices.length < 2 ? (
              <p className="text-xs text-neutral-400">
                Add at least two {answer === 'category' ? 'options' : 'levels'}{' '}
                first.
              </p>
            ) : answer === 'category' ? (
              <div className="space-y-1">
                {choices.map((key) => (
                  <label
                    key={key}
                    className="flex items-center gap-2 text-sm text-neutral-700"
                  >
                    <input
                      type="checkbox"
                      checked={(check.expected ?? []).includes(key)}
                      onChange={() => toggleExpected(key)}
                    />
                    {key}
                  </label>
                ))}
              </div>
            ) : (
              <select
                aria-label="Lowest passing level"
                value={check.minLevel ?? ''}
                onChange={(e) => {
                  return persist({
                    ...check,
                    minLevel: e.target.value || undefined,
                  })
                }}
                className="h-9 w-full rounded-md border border-neutral-300 bg-transparent px-2 text-sm outline-none focus:border-neutral-500"
              >
                <option value="">Pick a level…</option>
                {choices.map((key) => (
                  <option key={key} value={key}>
                    {key} or better
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <Label>Passes at</Label>
            <FieldHelp title="Passes at">
              <p>
                The probability at or above which this check passes:{' '}
                {answer === 'boolean'
                  ? 'the chance the answer is yes'
                  : answer === 'category'
                    ? 'the chance the answer is one of the passing options'
                    : 'the chance the answer is at the passing level or above'}
                . 0.5 treats it as a plain call; raise it when you would rather
                see a borderline row fail than pass.
              </p>
              <p>
                The judge never sees this number — it reports how likely each
                answer is, and the line is yours to draw.
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
                Pin the question to a single field of the target’s output
                instead of the whole thing, so unrelated fields can’t dilute it.
              </p>
            </FieldHelp>
          </div>
          <OutputPathSelect
            value={check.path}
            options={pathOptions}
            onSelect={(path) => persist({ ...check, path })}
            placeholder="blank = whole output"
          />
          {selectedField?.description ? (
            <p className="text-xs text-neutral-400">
              {selectedField.description}
            </p>
          ) : null}
        </div>
      </div>

      <TryCheck check={check} />
    </div>
  )
}

// ── Try this check ───────────────────────────────────────────────────────────
// Asks the deployment's default judge about a pasted answer, through the same
// grader a run uses — so a question can be tuned before a whole run is spent
// on it. Nothing is stored.

function TryCheck({ check }: { check: JudgeCheck }) {
  const { Button, Textarea } = useWfComponents()
  const [answerText, setAnswerText] = useState('')
  const preview = usePreviewJudgeCheck()
  const ask = () => {
    preview.mutate({ check, output: parseAnswer(answerText) })
  }

  return (
    <div className="space-y-2 rounded-md border border-neutral-200 bg-neutral-50 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-neutral-600">
          Try this check
        </span>
        <span className="text-xs text-neutral-400">Judge only · no run</span>
      </div>
      <Textarea
        rows={3}
        value={answerText}
        placeholder="Paste an answer — plain text, or the output as JSON."
        onChange={(e) => setAnswerText(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!check.rubric.trim() || !answerText.trim() || preview.isPending}
          onClick={ask}
        >
          {preview.isPending ? 'Asking…' : preview.data ? 'Ask again' : 'Ask the judge'}
        </Button>
        {preview.data?.decisionJudgeModelId ? (
          <span className="truncate text-xs text-neutral-400">
            {preview.data.decisionJudgeModelId}
          </span>
        ) : null}
      </div>
      {preview.error ? (
        <p className="text-xs text-red-600">{preview.error.message}</p>
      ) : null}
      {preview.data ? (
        <TryResult
          result={preview.data.result}
          threshold={check.threshold ?? DEFAULT_DECISION_THRESHOLD}
        />
      ) : null}
    </div>
  )
}

function TryResult({
  result,
  threshold,
}: {
  result: CheckResult
  threshold: number
}) {
  if (result.probability == null) {
    return <p className="text-xs text-red-600">{result.reason}</p>
  }
  const p = result.probability
  return (
    <div className="space-y-1">
      <ProbabilityBar probability={p} threshold={threshold} pass={result.pass} />
      <p className="text-xs text-neutral-600">
        <span className={result.pass ? 'font-semibold text-emerald-700' : 'font-semibold text-amber-700'}>
          {result.pass ? 'Pass' : 'Fail'}
        </span>{' '}
        · p={p.toFixed(2)}, {Math.abs(p - threshold).toFixed(2)}{' '}
        {result.pass ? 'above' : 'below'} the line
      </p>
    </div>
  )
}

/** A pasted answer as the target's output: JSON when it parses, else text. */
function parseAnswer(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
