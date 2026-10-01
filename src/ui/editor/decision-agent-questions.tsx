import { AlertTriangle, Plus, X } from 'lucide-react'

import {
  DECISION_QUESTION_TYPES,
  supportsQuestionType,
  type DecisionAgentQuestion,
  type DecisionModelOption,
  type DecisionRule,
} from '../../engine'
import { cn } from '../cn'
import { Tooltip } from '../tooltip'

import {
  GUTTER,
  Row,
  ThresholdScale,
  TYPE_HELP,
  TYPE_ICON,
  TYPE_LABEL,
  TYPE_SHORT,
} from './decision-question-types'

// The question list of a decision agent's editor.
//
// Authors the three question types against the provider contract, plus
// `considerations` — the per-question criteria
// Jev has read since ART-231 and which NO authoring surface could set until
// now. That is a live provider feature the product could not reach.
//
// Raw `<input>`/`<select>` rather than the host's injected primitives, for the
// same reason the node inspector uses them: `cn` is clsx alone (no
// tailwind-merge), so a className cannot shrink an injected control, and these
// rows need the compact size.

const FIELD =
  'border-input bg-card text-foreground placeholder:text-muted-foreground h-8 w-full rounded-md border px-2 text-xs outline-none focus:border-ring'

const AREA =
  'border-input bg-card text-foreground placeholder:text-muted-foreground min-h-[3.5rem] w-full resize-y rounded-md border px-2 py-1.5 text-xs leading-snug outline-none focus:border-ring [field-sizing:content]'

/** A stable key from a label: `Needs review` → `needs_review`. */
export function keyFromLabel(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, '_')
      .replaceAll(/^_+|_+$/g, '')
      .slice(0, 40) || 'option'
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const key = `${base}_${i}`
    if (!taken.has(key)) return key
  }
}

/** A fresh question id: `answer`, `answer_2`, … */
export function nextQuestionId(
  existing: readonly DecisionAgentQuestion[],
): string {
  return keyFromLabel('answer', new Set(existing.map((q) => q.id)))
}

export function newDecisionQuestion(
  existing: readonly DecisionAgentQuestion[],
): DecisionAgentQuestion {
  return {
    id: nextQuestionId(existing),
    type: 'boolean',
    prompt: '',
    considerations: {},
    choices: [],
  }
}

export function DecisionQuestionList({
  questions,
  rules,
  model,
  onChange,
}: {
  questions: DecisionAgentQuestion[]
  rules: DecisionRule[]
  model: DecisionModelOption | undefined
  onChange: (patch: {
    questions: DecisionAgentQuestion[]
    rules?: DecisionRule[]
  }) => void
}) {
  const setQuestion = (index: number, patch: Partial<DecisionAgentQuestion>) => {
    onChange({
      questions: questions.map((q, i) => (i === index ? { ...q, ...patch } : q)),
    })
  }
  /** How many rules read each question — the cost of renaming or removing it. */
  const readers = (id: string) => {
    return rules.filter((r) => r.conditions.some((c) => c.questionId === id))
      .length
  }
  /**
   * The name is an address, so a rename has to be followed wherever it is used
   * — otherwise renaming a question quietly detaches every rule that reads it,
   * and the only sign is a validation message about an id nobody typed. Eval
   * expectations live in another entity and cannot be reached from here; the
   * hint under the field says so.
   */
  const renameQuestion = (index: number, id: string) => {
    const from = questions[index]?.id
    onChange({
      questions: questions.map((q, j) => (j === index ? { ...q, id } : q)),
      rules: rules.map((rule) => {
        return {
          ...rule,
          conditions: rule.conditions.map((c) => {
            return c.questionId === from ? { ...c, questionId: id } : c
          }),
        }
      }),
    })
  }
  return (
    <div className="space-y-2">
      {questions.map((question, i) => (
        <QuestionCard
          key={i}
          question={question}
          usedBy={readers(question.id)}
          model={model}
          onChange={(patch) => setQuestion(i, patch)}
          onRename={(raw) => {
            // An emptied field is a cleared input, not a request to be called
            // `option` (what `keyFromLabel` falls back to) — so it keeps the
            // name it has.
            if (!raw.trim()) return
            const taken = new Set(
              questions.filter((_, j) => j !== i).map((q) => q.id),
            )
            const id = keyFromLabel(raw, taken)
            if (id === question.id) return
            renameQuestion(i, id)
          }}
          onRemove={() => {
            onChange({ questions: questions.filter((_, j) => j !== i) })
          }}
        />
      ))}
      <button
        type="button"
        className="border-input hover:bg-accent text-muted-foreground hover:text-foreground flex w-full items-center justify-center gap-1 rounded-md border border-dashed py-1.5 text-xs"
        onClick={() => {
          onChange({ questions: [...questions, newDecisionQuestion(questions)] })
        }}
      >
        <Plus className="size-3" /> Add a question
      </button>
      <p className="text-muted-foreground text-xs">
        Every question goes out in ONE request against the same state, so asking
        five costs the same round trip as asking one. The rules below turn the
        answers into a single verdict.
      </p>
    </div>
  )
}

function QuestionCard({
  question,
  usedBy,
  model,
  onChange,
  onRename,
  onRemove,
}: {
  question: DecisionAgentQuestion
  usedBy: number
  model: DecisionModelOption | undefined
  onChange: (patch: Partial<DecisionAgentQuestion>) => void
  onRename: (raw: string) => void
  onRemove: () => void
}) {
  const needsChoices = question.type !== 'boolean'
  const unsupported =
    model != null && !supportsQuestionType(model, question.type)
  const considerations = Object.entries(question.considerations)

  const setChoices = (choices: DecisionAgentQuestion['choices']) => {
    onChange({ choices })
  }
  const setConsiderations = (entries: [string, string][]) => {
    onChange({ considerations: Object.fromEntries(entries) })
  }

  return (
    <div className="border-input space-y-1.5 rounded-md border p-2">
      {/* The id is the name AND the address: a rule names it, and so does an
          eval expectation. It used to render as a grey tag, which read as a
          system-assigned label rather than a field — so it now sits in the
          same labelled row as everything else on the card, in the same
          editable box, and says underneath what naming it is FOR. Still
          committed on blur/Enter rather than per keystroke, so a half-typed
          name never becomes the one a rule points at. */}
      <div className="flex items-center gap-2">
        {/* The hazard sits ON the label, as an icon with the detail behind it.
            An amber paragraph under the field is the right ALARM for the
            consequence and the wrong weight for a card you scroll past twenty
            times while writing a question. An icon beside the thing it is about
            stays visible without competing with the field for attention, and the
            sentence is one hover away.

            Shown only when something actually reads the name: a question nothing
            points at renames freely, and an icon that is always there is an icon
            nobody reads. */}
        <span className="text-muted-foreground flex w-16 shrink-0 items-center justify-end gap-1 text-[11px]">
          Name
          {usedBy > 0 ? (
            <Tooltip
              side="top"
              content={
                <>
                  Renaming updates the{' '}
                  {usedBy === 1 ? '1 rule' : `${usedBy} rules`} that read it,
                  here — in the same undo step. It does <b>not</b> update eval
                  samples: a Goal expecting <b>{question.id}</b> will quietly
                  stop grading this answer and still report a pass. Fix those by
                  hand.
                </>
              }
            >
              <AlertTriangle
                className="size-3 shrink-0 text-amber-600"
                aria-label={`Renaming ${question.id} affects ${usedBy} rule${usedBy === 1 ? '' : 's'} and will not update eval samples`}
              />
            </Tooltip>
          ) : null}
        </span>
        <input
          className={cn(FIELD, 'font-mono')}
          aria-label={`Name of question ${question.id}`}
          placeholder="needs_review — a short name, no spaces"
          defaultValue={question.id}
          key={question.id}
          onBlur={(e) => {
            if (!e.target.value.trim()) e.target.value = question.id
            onRename(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              e.currentTarget.value = question.id
              e.currentTarget.blur()
            }
          }}
        />
        <button
          type="button"
          aria-label={`Remove question ${question.id}`}
          className="text-muted-foreground hover:text-foreground hover:bg-accent shrink-0 rounded p-1"
          onClick={onRemove}
        >
          <X className="size-3.5" />
        </button>
      </div>
      <p className={cn(GUTTER, 'text-muted-foreground text-[11px]')}>
        What the rules and your eval samples call this answer.{' '}
        {usedBy === 0 ? 'Rename it freely — nothing reads it yet.' : null}
      </p>

      {/* A textarea, not an input. A question's wording IS the prompt — the whole
          instruction the provider judges against, and usually two or three
          sentences once it names the edge cases — so a one-line box showed a
          sliver of it with the rest scrolled out of view.
          `field-sizing-content` grows it with what is typed; `min-h` stops an
          empty one collapsing into something that looks single-line again. */}
      <Row label="Ask" align="start">
        <textarea
          className={cn(AREA, !question.prompt.trim() && 'border-destructive')}
          rows={2}
          placeholder="Does this need a person to look at it before we act?"
          aria-label={`Prompt for ${question.id}`}
          value={question.prompt}
          onChange={(e) => onChange({ prompt: e.target.value })}
        />
      </Row>

      {/* All three shapes on screen at once rather than behind a dropdown.
          There are exactly three, they are the single most consequential
          choice on the card — they decide what the provider is asked for and
          which comparisons a rule may use — and a closed <select> showed one
          of them while hiding that a choice was being made at all. */}
      <Row label="Answer">
        <div
          role="radiogroup"
          aria-label={`Answer type for ${question.id}`}
          className={cn(
            'border-input bg-muted/40 flex w-full gap-0.5 rounded-md border p-0.5',
            unsupported && 'border-destructive',
          )}
        >
          {DECISION_QUESTION_TYPES.map((t) => {
            const active = question.type === t
            const Icon = TYPE_ICON[t]
            // Marked, not removed: a saved question can already be of a type
            // the currently picked model can't answer, and hiding the segment
            // would hide why the card is complaining.
            const blocked = model != null && !supportsQuestionType(model, t)
            return (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={active}
                title={
                  blocked
                    ? `This decider can’t answer “${TYPE_LABEL[t]}” questions.`
                    : TYPE_HELP[t]
                }
                className={cn(
                  'flex flex-1 items-center justify-center gap-1 rounded px-1.5 py-1 text-xs transition-colors',
                  active
                    ? 'border-input bg-card text-foreground border shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                  blocked && 'line-through opacity-60',
                )}
                onClick={() => {
                  if (active) return
                  // Clearing the irrelevant half on the way through stops a
                  // stale value outliving the type that gave it meaning — and
                  // a rule that reads a threshold on what is now a category
                  // question.
                  onChange({
                    type: t,
                    choices: t === 'boolean' ? [] : question.choices,
                    threshold: t === 'boolean' ? question.threshold : undefined,
                    considerations:
                      t === 'boolean' ? question.considerations : {},
                  })
                }}
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="truncate">{TYPE_SHORT[t]}</span>
              </button>
            )
          })}
        </div>
      </Row>
      <p className={cn(GUTTER, 'text-muted-foreground text-[11px]')}>
        {unsupported
          ? `This decider can’t answer “${TYPE_LABEL[question.type]}” questions — pick another type or another model.`
          : TYPE_HELP[question.type]}
      </p>

      {question.type === 'boolean' ? (
        <>
          {/* "Yes above", as a scale rather than a number box — see
              `ThresholdScale`. The label stays a preposition because that is
              what the control does: everything above the mark is a yes. */}
          <Row label="Yes above" align="start">
            <ThresholdScale
              value={question.threshold}
              label={question.id}
              onChange={(threshold) => onChange({ threshold })}
            />
          </Row>

          {/* Considerations — the provider's own within-question structure, and
              the reason this editor is not just the node inspector again. Each
              is a named thing to weigh; the model is told about them by name,
              so an answer can be argued with rather than only accepted. */}
          <div className="space-y-1.5">
            <Row label="Weigh">
              <span className="text-muted-foreground text-[11px]">
                Factors to take into account, each a short name and what it
                means. The model is told both, so it can answer{' '}
                <i>because</i> of something rather than only answering.
              </span>
            </Row>
            {/* STACKED, not side by side. A consideration is a name plus a
                sentence, and this card sits in a half-width column: two inputs
                on one line left the sentence about 80px wide — present, but
                impossible to read or type into. Each is now its own small block,
                name over meaning, so both get the full width and the pair still
                reads as one unit.

                It also makes their different jobs obvious, which the cramped
                version hid: the mono field is the KEY the model is told (and a
                rule could name), the wide one is what it means. */}
            {considerations.map(([name, text], i) => (
              <div
                key={i}
                className="border-input/60 bg-muted/20 ml-[72px] space-y-1 rounded-md border p-1.5"
              >
                <div className="flex items-center gap-1">
                  <input
                    className={cn(FIELD, 'font-mono')}
                    placeholder="overdue — name this factor"
                    aria-label={`Consideration ${i + 1} name for ${question.id}`}
                    value={name}
                    onChange={(e) => {
                      const next = [...considerations]
                      next[i] = [e.target.value, text]
                      setConsiderations(next)
                    }}
                  />
                  <button
                    type="button"
                    aria-label={`Remove consideration ${name}`}
                    className="text-muted-foreground hover:text-foreground hover:bg-accent shrink-0 rounded p-1"
                    onClick={() => {
                      setConsiderations(considerations.filter((_, j) => j !== i))
                    }}
                  >
                    <X className="size-3" />
                  </button>
                </div>
                <input
                  className={FIELD}
                  placeholder="What counts as overdue here — say, no reply in 48 hours"
                  aria-label={`Consideration ${i + 1} for ${question.id}`}
                  value={text}
                  onChange={(e) => {
                    const next = [...considerations]
                    next[i] = [name, e.target.value]
                    setConsiderations(next)
                  }}
                />
              </div>
            ))}
            <div className={GUTTER}>
              <button
                type="button"
                className="border-input hover:bg-accent text-muted-foreground hover:text-foreground flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-[11px]"
                onClick={() => {
                  const taken = new Set(considerations.map(([k]) => k))
                  setConsiderations([
                    ...considerations,
                    [keyFromLabel('consideration', taken), ''],
                  ])
                }}
              >
                <Plus className="size-3" /> Add a consideration
              </button>
            </div>
          </div>
        </>
      ) : null}

      {needsChoices ? (
        <div className="space-y-1.5">
          <div className={cn(GUTTER, 'text-muted-foreground text-[11px]')}>
            {question.type === 'scale'
              ? 'The levels, lowest first — the order IS the scale, and the rules compare through it ("at least today"). Rewriting the order rewrites every answer.'
              : 'The options. The answer is exactly one of them, with the odds it gave each of the others.'}
          </div>
          {question.choices.map((choice, i) => (
            <Row
              key={i}
              align="start"
              label={question.type === 'scale' ? `${i}` : '·'}
            >
              <div className="flex items-center gap-1">
                <input
                  className={FIELD}
                  placeholder={
                    question.type === 'scale'
                      ? i === 0
                        ? 'Whenever — the lowest level'
                        : 'Name this level'
                      : 'Billing — name one option'
                  }
                  aria-label={`Choice ${i + 1} of ${question.id}`}
                  value={choice.label ?? ''}
                  onChange={(e) => {
                    const label = e.target.value
                    const taken = new Set(
                      question.choices
                        .filter((_, j) => j !== i)
                        .map((c) => c.key),
                    )
                    // The key is re-derived only while the author hasn't leaned
                    // on it — once a rule names a key, renaming the label must
                    // not silently repoint it.
                    const stillDerived =
                      choice.key === keyFromLabel(choice.label ?? '', new Set())
                    setChoices(
                      question.choices.map((c, j) => { return j === i
                          ? {
                              ...c,
                              label,
                              key: stillDerived ? keyFromLabel(label, taken) : c.key,
                            }
                          : c },
                      ),
                    )
                  }}
                />
                <button
                  type="button"
                  aria-label={`Remove choice ${choice.key}`}
                  className="text-muted-foreground hover:text-foreground hover:bg-accent shrink-0 rounded p-1"
                  onClick={() => {
                    setChoices(question.choices.filter((_, j) => j !== i))
                  }}
                >
                  <X className="size-3" />
                </button>
              </div>
              {/* The key UNDER the label, not beside it. It was a `shrink-0` tag
                  on the same line, so a key as ordinary as
                  `needs_attention_today` pushed the row past the card's edge and
                  squeezed the input it describes. Below, it truncates instead —
                  and the pairing is clearer anyway: this is the name the rules
                  use for the label above. */}
              {choice.key ? (
                <span
                  className="text-muted-foreground block truncate pl-1 font-mono text-[10px]"
                  title={choice.key}
                >
                  {choice.key}
                </span>
              ) : null}
            </Row>
          ))}
          <div className={GUTTER}>
            <button
              type="button"
              className="border-input hover:bg-accent text-muted-foreground hover:text-foreground flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-[11px]"
              onClick={() => {
                const taken = new Set(question.choices.map((c) => c.key))
                setChoices([
                  ...question.choices,
                  { key: keyFromLabel('', taken), label: '' },
                ])
              }}
            >
              <Plus className="size-3" />
              {question.type === 'scale' ? 'Add a level' : 'Add an option'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
