import { ArrowDown, ArrowUp, ArrowUpDown, Plus, X } from 'lucide-react'

import {
  DECISION_CONDITION_OPS_BY_TYPE,
  type DecisionAgentQuestion,
  type DecisionConditionOp,
  type DecisionRule,
  type DecisionRuleCondition,
} from '../../engine'
import { cn } from '../cn'

import { ThresholdScale } from './decision-question-types'

// The rollup: ordered rules, first match wins.
//
// This is the layer Jev deliberately does not provide — "the caller picks the
// threshold, because where to cut is a policy decision and not the model's" —
// so the agent, not the provider, decides. It is also what makes the output one
// gradeable value, which is what an eval needs.
//
// Two shapes it deliberately is NOT:
//
//   • Nested boolean algebra. Every condition in a rule must hold (AND), and
//     OR is spelled as two rules naming the same verdict. First-match-wins over
//     an ordered list already expresses everything a tree would, while staying
//     readable to the person whose request got escalated and lintable by the
//     editor.
//   • A weighted score. Jev's `score` answers are already probability-weighted
//     indices, so weighting them again double-counts the mass — and a weight is
//     far harder to justify to a human than "rule 2 fired".

const FIELD =
  'border-input bg-card text-foreground placeholder:text-muted-foreground h-8 rounded-md border px-2 text-xs outline-none focus:border-ring'

/** The verb each op reads as in the rule row. */
const OP_LABEL: Record<DecisionConditionOp, string> = {
  gte: 'is at least',
  lt: 'is below',
  is: 'is',
  equals: 'is',
  in: 'is one of',
  atLeast: 'is at least',
  atMost: 'is at most',
}

export function DecisionRulesEditor({
  rules,
  questions,
  verdicts,
  onChange,
}: {
  rules: DecisionRule[]
  questions: DecisionAgentQuestion[]
  verdicts: string[]
  onChange: (next: DecisionRule[]) => void
}) {
  const setRule = (index: number, patch: Partial<DecisionRule>) => {
    onChange(rules.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }
  // Reordering is bounded by the fallback, which must stay last: a rule moved
  // below it could never match, and silently making a rule unreachable is a
  // worse outcome than refusing the move.
  const move = (index: number, delta: number) => {
    const to = index + delta
    if (to < 0 || to > lastOrderableIndex(rules)) return
    const next = [...rules]
    const [moved] = next.splice(index, 1)
    next.splice(to, 0, moved)
    onChange(next)
  }
  const nextRuleId = () => {
    const taken = new Set(rules.map((r) => r.id))
    for (let i = rules.length + 1; ; i++) {
      if (!taken.has(`rule_${i}`)) return `rule_${i}`
    }
  }

  return (
    <div className="space-y-2">
      {/* Said FIRST, not only in the paragraph underneath. The order of this
          list is the logic — first match wins — so "you can reorder these" is
          not a tip, it is half of how the editor works. It was discoverable only
          by noticing two small chevrons, which is to say it wasn't. */}
      {rules.length > 1 ? (
        <p className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
          <ArrowUpDown className="size-3 shrink-0" />
          <span>
            Checked <b>top to bottom</b> — the first rule that matches wins, so
            the order is part of the logic. Reorder with the arrows on each rule.
          </span>
        </p>
      ) : null}
      {rules.map((rule, i) => {
        const isFallback = rule.conditions.length === 0
        return (
          <div
            key={rule.id}
            className={cn(
              'border-input space-y-1.5 rounded-md border p-2',
              isFallback && 'bg-muted/40',
            )}
          >
            {/* HEADER: which rule this is, and the controls that reorder it.
                Separated from the verdict (now its own `then` line at the
                bottom) because cramming `if … then <verdict>` plus three icon
                buttons onto one line overflowed a half-width card — and because
                a rule reads as a sentence that ends in its verdict, so the
                verdict belongs after the conditions, not above them. */}
            <div className="flex items-center gap-2">
              {/* The position, stated. Rules are evaluated in this order and
                  first match wins, so the number is semantics — and showing it
                  is what makes the reorder arrows beside it look like they do
                  something, rather than decoration someone might never try. */}
              <span
                className="border-input bg-muted text-muted-foreground shrink-0 rounded border px-1.5 text-[10px] tabular-nums"
                title={`Rule ${i + 1} of ${rules.length} — checked in this order`}
              >
                {i + 1}
              </span>
              <span className="text-foreground min-w-0 flex-1 text-[11px] font-medium">
                {isFallback ? 'otherwise' : i === 0 ? 'if' : 'else if'}
              </span>
              {/* Order is the semantics here, not presentation — moving a rule
                  up can change every decision this agent makes. Labelled
                  "Reorder" rather than left as bare chevrons, since the whole
                  problem was that nobody knew the list could be reordered. */}
              {isFallback ? null : (
                <span className="flex shrink-0 items-center">
                  <span className="text-muted-foreground pr-1 text-[10px]">
                    reorder
                  </span>
                  <button
                    type="button"
                    aria-label={`Move rule ${i + 1} up`}
                    title="Move earlier — it will be checked before the rules above it"
                    disabled={i === 0}
                    className="text-muted-foreground hover:text-foreground hover:bg-accent rounded p-1 disabled:opacity-30"
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp className="size-3" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move rule ${i + 1} down`}
                    title="Move later — the rules above it get to match first"
                    disabled={i >= lastOrderableIndex(rules)}
                    className="text-muted-foreground hover:text-foreground hover:bg-accent rounded p-1 disabled:opacity-30"
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown className="size-3" />
                  </button>
                </span>
              )}
              <button
                type="button"
                aria-label={`Remove rule ${i + 1}`}
                className="text-muted-foreground hover:text-foreground hover:bg-accent shrink-0 rounded p-1"
                onClick={() => onChange(rules.filter((_, j) => j !== i))}
              >
                <X className="size-3.5" />
              </button>
            </div>

            {rule.conditions.map((condition, ci) => (
              <ConditionRow
                key={ci}
                condition={condition}
                questions={questions}
                leading={ci === 0 ? '' : 'and'}
                onChange={(patch) => {
                  setRule(i, {
                    conditions: rule.conditions.map((c, j) => { return j === ci ? { ...c, ...patch } : c },
                    ),
                  })
                }}
                onRemove={() => {
                  setRule(i, {
                    conditions: rule.conditions.filter((_, j) => j !== ci),
                  })
                }}
              />
            ))}

            <div className="pl-6">
              <button
                type="button"
                className="border-input hover:bg-accent text-muted-foreground hover:text-foreground flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-[11px]"
                onClick={() => {
                  const question = questions[0]
                  setRule(i, {
                    conditions: [
                      ...rule.conditions,
                      defaultCondition(question),
                    ],
                  })
                }}
              >
                <Plus className="size-3" />
                {rule.conditions.length === 0
                  ? 'Add a condition (this is the fallback)'
                  : 'and…'}
              </button>
            </div>

            {/* THEN, on its own line and at the end — where the sentence puts
                it. The verdict is the rule's product, and the one field an
                author scans for when reading the list as a policy, so it gets
                the full width instead of a 144px box wedged between the
                conditions and three icon buttons. */}
            <div className="flex items-center gap-2 pt-0.5">
              <span className="text-foreground w-6 shrink-0 text-[11px] font-medium">
                then
              </span>
              <select
                className={cn(
                  FIELD,
                  'min-w-0 flex-1',
                  !verdicts.includes(rule.verdict) && 'border-destructive',
                )}
                aria-label={`Verdict for rule ${i + 1}`}
                value={rule.verdict}
                onChange={(e) => setRule(i, { verdict: e.target.value })}
              >
                {verdicts.includes(rule.verdict) ? null : (
                  <option value={rule.verdict}>
                    {rule.verdict || '(pick a verdict)'}
                  </option>
                )}
                {verdicts.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )
      })}

      <button
        type="button"
        className="border-input hover:bg-accent text-muted-foreground hover:text-foreground flex w-full items-center justify-center gap-1 rounded-md border border-dashed py-1.5 text-xs"
        onClick={() => {
          // Inserted BEFORE the fallback when there is one: a rule added after
          // it could never match, and silently making it unreachable is worse
          // than putting it where the author meant it.
          const rule: DecisionRule = {
            id: nextRuleId(),
            verdict: verdicts[0] ?? '',
            conditions: [defaultCondition(questions[0])],
          }
          const last = rules.at(-1)
          if (last && last.conditions.length === 0) {
            onChange([...rules.slice(0, -1), rule, last])
          } else {
            onChange([...rules, rule])
          }
        }}
      >
        <Plus className="size-3" /> Add a rule
      </button>

      <p className="text-muted-foreground text-xs">
        Every condition in a rule must hold for it to match. The last rule must
        have no conditions — it is the fallback, and it is what guarantees every
        state reaches an answer, which is why nothing can be moved below it. Two
        rules naming the same verdict is how you say “or”.
      </p>
    </div>
  )
}

/**
 * The furthest index a rule may be moved to.
 *
 * `rules.length - 1` normally, but one less when the list ends in the
 * unconditional fallback — that rule matches everything, so anything below it is
 * dead code, and the editor refuses to put a rule there rather than letting an
 * author discover it from a verdict that never appears.
 */
function lastOrderableIndex(rules: DecisionRule[]): number {
  const last = rules.at(-1)
  const hasFallback = last != null && last.conditions.length === 0
  return hasFallback ? rules.length - 2 : rules.length - 1
}

/** A condition that makes sense for `question` the moment it is added. */
function defaultCondition(
  question: DecisionAgentQuestion | undefined,
): DecisionRuleCondition {
  if (!question) return { questionId: '', op: 'is', yes: true, keys: [] }
  if (question.type === 'boolean') {
    return { questionId: question.id, op: 'is', yes: true, keys: [] }
  }
  const key = question.choices[0]?.key ?? ''
  return {
    questionId: question.id,
    op: question.type === 'category' ? 'equals' : 'atLeast',
    keys: key ? [key] : [],
  }
}

function ConditionRow({
  condition,
  questions,
  leading,
  onChange,
  onRemove,
}: {
  condition: DecisionRuleCondition
  questions: DecisionAgentQuestion[]
  leading: string
  onChange: (patch: Partial<DecisionRuleCondition>) => void
  onRemove: () => void
}) {
  const question = questions.find((q) => q.id === condition.questionId)
  const ops = question
    ? DECISION_CONDITION_OPS_BY_TYPE[question.type]
    : ([condition.op] as const)

  // TWO LINES, not one wrapping row.
  //
  // It was `flex-wrap` over four fixed-width controls — a 40px gutter, a 144px
  // question, a 112px operator and a 160px value — which needs ~470px and had
  // roughly 300px in a half-width card. So it wrapped mid-sentence, at a
  // different place for every condition, and the rule stopped being readable as
  // one statement.
  //
  // Now the subject gets its own line and the comparison sits under it, indented:
  //
  //     and  needs_review
  //          is at least   0.7
  //
  // Which is the same sentence, broken where a sentence can be broken. Each
  // control fills its line, so nothing depends on the card's width any more.
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground w-6 shrink-0 text-[11px]">
          {leading}
        </span>
        <select
          className={cn(FIELD, 'min-w-0 flex-1 font-mono')}
          aria-label="Question"
          value={condition.questionId}
          onChange={(e) => {
            // Re-default the comparison: an op valid for the old question's type
            // is usually invalid for the new one, and leaving it would produce a
            // condition the validator rejects and the author didn't write.
            const next = questions.find((q) => q.id === e.target.value)
            onChange(defaultCondition(next))
          }}
        >
          {questions.some((q) => q.id === condition.questionId) ? null : (
            <option value={condition.questionId}>
              {condition.questionId || '(pick a question)'}
            </option>
          )}
          {questions.map((q) => (
            <option key={q.id} value={q.id}>
              {q.id}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label={`Remove condition on ${condition.questionId}`}
          className="text-muted-foreground hover:text-foreground hover:bg-accent shrink-0 rounded p-1"
          onClick={onRemove}
        >
          <X className="size-3" />
        </button>
      </div>

      <div className="flex items-center gap-1.5 pl-6">
        <select
          className={cn(FIELD, 'w-28 shrink-0')}
          aria-label={`Comparison for ${condition.questionId}`}
          value={condition.op}
          onChange={(e) => {
            const op = e.target.value as DecisionConditionOp
            // Each op reads exactly one of the three value fields; clearing the
            // others keeps a stale number from sitting behind a key comparison.
            onChange({
              op,
              probability:
                op === 'gte' || op === 'lt'
                  ? (condition.probability ?? 0.7)
                  : undefined,
              yes: op === 'is' ? (condition.yes ?? true) : undefined,
              keys:
                op === 'gte' || op === 'lt' || op === 'is' ? [] : condition.keys,
            })
          }}
        >
          {ops.map((op) => (
            <option key={op} value={op}>
              {OP_LABEL[op]}
            </option>
          ))}
        </select>
        <span className="min-w-0 flex-1">
          <ConditionValue
            condition={condition}
            question={question}
            onChange={onChange}
          />
        </span>
      </div>
    </div>
  )
}

function ConditionValue({
  condition,
  question,
  onChange,
}: {
  condition: DecisionRuleCondition
  question: DecisionAgentQuestion | undefined
  onChange: (patch: Partial<DecisionRuleCondition>) => void
}) {
  if (condition.op === 'gte' || condition.op === 'lt') {
    // The same scale the question's own cut uses, in its compact form: a bare
    // `0.7` in a number box never said what it was 0.7 OF. Here it reads as
    // "needs_review is at least 70%", which is the sentence the rule is.
    return (
      <ThresholdScale
        value={condition.probability}
        label={condition.questionId}
        guidance={false}
        ariaLabel={`Probability for ${condition.questionId}`}
        onChange={(probability) => onChange({ probability })}
      />
    )
  }
  if (condition.op === 'is') {
    return (
      <select
        className={cn(FIELD, 'w-full')}
        aria-label={`Expected answer for ${condition.questionId}`}
        value={condition.yes === false ? 'no' : 'yes'}
        onChange={(e) => onChange({ yes: e.target.value === 'yes' })}
      >
        <option value="yes">yes</option>
        <option value="no">no</option>
      </select>
    )
  }

  const choices = question?.choices ?? []
  if (condition.op === 'in') {
    // Multi-select rather than a row of checkboxes: `in` is rarely more than two
    // or three keys, so a short scrolling list costs less vertical space than
    // one checkbox per option and keeps the condition to its two lines.
    return (
      <select
        multiple
        className={cn(FIELD, 'h-16 w-full py-1')}
        aria-label={`Choices for ${condition.questionId}`}
        value={condition.keys}
        onChange={(e) => {
          onChange({
            keys: [...e.target.selectedOptions].map((o) => o.value),
          })
        }}
      >
        {choices.map((c) => (
          <option key={c.key} value={c.key}>
            {c.label || c.key}
          </option>
        ))}
      </select>
    )
  }
  return (
    <select
      className={cn(FIELD, 'w-full')}
      aria-label={`Choice for ${condition.questionId}`}
      value={condition.keys[0] ?? ''}
      onChange={(e) => onChange({ keys: e.target.value ? [e.target.value] : [] })}
    >
      <option value="">(pick one)</option>
      {choices.map((c) => (
        <option key={c.key} value={c.key}>
          {c.label || c.key}
        </option>
      ))}
    </select>
  )
}
