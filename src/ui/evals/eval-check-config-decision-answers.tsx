import { Plus, X } from 'lucide-react'

import type {
  DecisionExpectation,
  EvalCheck,
  WfDecisionAgentSummary,
} from '../../server/protocol'
import { cn } from '../cn'
import { useWfComponents } from '../context'

// The `decision_answers` check — the whole decision matrix graded as one row.
//
// Why it is one check and not N: a decision agent answers every question in one
// provider call, so "was this state judged correctly" is one question about one
// answer, and splitting it into an `output_match` per question would give you a
// column of five rows that always pass or fail together, four of them costing a
// click to read. It also could not express the tolerance — `output_match` can
// compare `answers.is_urgent.value`, but not "yes, and at least 0.7".
//
// No judge runs. The output is already structured, so grading it is a
// comparison — which means a decision Goal costs exactly one provider call per
// cell and has no judge flakiness in its score at all.

const FIELD =
  'h-8 w-full rounded-md border border-neutral-200 bg-white px-2 text-xs text-neutral-800 outline-none focus:border-neutral-400'

export function DecisionAnswersFields({
  check,
  persist,
  contract,
}: {
  check: Extract<EvalCheck, { type: 'decision_answers' }>
  persist: (next: EvalCheck) => void
  /**
   * The target agent's published matrix — its question ids and the verdicts it
   * can reach. Undefined when the goal targets something else, or the agent has
   * never been published; the fields then fall back to free text rather than
   * offering an empty picker.
   */
  contract: WfDecisionAgentSummary | null | undefined
}) {
  const { Label } = useWfComponents()
  const questionIds = contract?.questionIds ?? []
  const verdicts = contract?.verdicts ?? []

  const setExpect = (expect: DecisionExpectation[]) => {
    persist({ ...check, expect })
  }
  const patch = (index: number, next: Partial<DecisionExpectation>) => {
    setExpect(
      check.expect.map((e, i) => (i === index ? { ...e, ...next } : e)),
    )
  }
  // The next question with nothing pinned yet — one row per question is the
  // shape an author wants, and offering a duplicate first is a papercut.
  const unused = questionIds.find(
    (id) => !check.expect.some((e) => e.questionId === id),
  )

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className="text-xs">Verdict</Label>
        {verdicts.length > 0 ? (
          <select
            className={FIELD}
            aria-label="Expected verdict"
            value={check.verdict ?? ''}
            onChange={(e) => {
              persist({ ...check, verdict: e.target.value || undefined })
            }}
          >
            <option value="">Don’t grade the verdict</option>
            {verdicts.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        ) : (
          <input
            className={FIELD}
            aria-label="Expected verdict"
            placeholder="escalate"
            value={check.verdict ?? ''}
            onChange={(e) => {
              persist({ ...check, verdict: e.target.value || undefined })
            }}
          />
        )}
        <p className="text-xs text-neutral-400">
          The rollup&apos;s answer — what would actually act on the world. Leave
          it ungraded to tune the questions before the rules.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Expected answers</Label>
        {check.expect.length === 0 ? (
          <p className="text-xs text-neutral-400">
            Nothing pinned per question — this check grades the verdict alone.
          </p>
        ) : null}
        {check.expect.map((expectation, i) => (
          <ExpectationRow
            key={i}
            expectation={expectation}
            questionIds={questionIds}
            onChange={(next) => patch(i, next)}
            onRemove={() => {
              setExpect(check.expect.filter((_, j) => j !== i))
            }}
          />
        ))}
        <button
          type="button"
          className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-neutral-200 py-1.5 text-xs text-neutral-500 hover:bg-neutral-50 hover:text-neutral-800"
          onClick={() => {
            setExpect([
              ...check.expect,
              { questionId: unused ?? questionIds[0] ?? '', yes: true },
            ])
          }}
        >
          <Plus className="size-3" /> Expect an answer
        </button>
      </div>
    </div>
  )
}

/**
 * One question's expected answer.
 *
 * The value field is deliberately NOT keyed off the question's type. This
 * editor reads the agent's SUMMARY (question ids and verdicts), which is what a
 * card needs and what `listAgents` can afford to compute — it does not carry
 * each question's type or choices. So the author says which they mean by
 * filling the yes/no control or the key box, and the grader reads whichever the
 * actual answer's type makes sense of. Getting it wrong is a legible failure
 * ("is_urgent expected billing, got yes"), not a silent pass.
 */
function ExpectationRow({
  expectation,
  questionIds,
  onChange,
  onRemove,
}: {
  expectation: DecisionExpectation
  questionIds: string[]
  onChange: (next: Partial<DecisionExpectation>) => void
  onRemove: () => void
}) {
  const answerMode = expectation.key != null ? 'key' : 'yes'
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-neutral-200 p-1.5">
      {questionIds.length > 0 ? (
        <select
          className={cn(FIELD, 'h-7 w-40')}
          aria-label="Question"
          value={expectation.questionId}
          onChange={(e) => onChange({ questionId: e.target.value })}
        >
          {questionIds.includes(expectation.questionId) ? null : (
            <option value={expectation.questionId}>
              {expectation.questionId || '(pick a question)'}
            </option>
          )}
          {questionIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      ) : (
        <input
          className={cn(FIELD, 'h-7 w-40 font-mono')}
          aria-label="Question"
          placeholder="question id"
          value={expectation.questionId}
          onChange={(e) => onChange({ questionId: e.target.value })}
        />
      )}

      <select
        className={cn(FIELD, 'h-7 w-28')}
        aria-label={`Answer shape for ${expectation.questionId}`}
        value={answerMode}
        onChange={(e) => {
          // Clearing the other half on the way through: a stale `key` beside a
          // fresh `yes` would have the grader compare both, and the author can
          // only see one of them.
          return e.target.value === 'key'
            ? onChange({ yes: undefined, key: '' })
            : onChange({ key: undefined, yes: true })
        }}
      >
        <option value="yes">is yes/no</option>
        <option value="key">is the choice</option>
      </select>

      {answerMode === 'key' ? (
        <input
          className={cn(FIELD, 'h-7 flex-1 font-mono')}
          aria-label={`Expected choice for ${expectation.questionId}`}
          placeholder="billing"
          value={expectation.key ?? ''}
          onChange={(e) => onChange({ key: e.target.value })}
        />
      ) : (
        <select
          className={cn(FIELD, 'h-7 w-24')}
          aria-label={`Expected answer for ${expectation.questionId}`}
          value={expectation.yes === false ? 'no' : 'yes'}
          onChange={(e) => onChange({ yes: e.target.value === 'yes' })}
        >
          <option value="yes">yes</option>
          <option value="no">no</option>
        </select>
      )}

      <label className="flex items-center gap-1 text-[11px] text-neutral-400">
        at least
        <input
          className={cn(FIELD, 'h-7 w-16')}
          type="number"
          min={0}
          max={1}
          step={0.05}
          placeholder="—"
          aria-label={`Minimum probability for ${expectation.questionId}`}
          value={expectation.minProbability ?? ''}
          onChange={(e) => {
            const raw = e.target.value
            onChange({
              minProbability: raw === '' ? undefined : Number(raw),
            })
          }}
        />
      </label>

      <button
        type="button"
        aria-label={`Remove expectation for ${expectation.questionId}`}
        className="shrink-0 rounded p-1 text-neutral-300 hover:bg-neutral-100 hover:text-neutral-600"
        onClick={onRemove}
      >
        <X className="size-3" />
      </button>
    </div>
  )
}
