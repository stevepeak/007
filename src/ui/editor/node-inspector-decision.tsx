import { Plus, X } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import {
  DECISION_QUESTION_TYPES,
  renameGraphRefPaths,
  supportsQuestionType,
  type DecisionModelOption,
  type DecisionNode,
  type DecisionNodeQuestion,
  type DecisionQuestionType,
  type JsonSchema,
  type WorkflowGraph,
} from '../../engine'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import { useDecisionModels, useDecisionProviders } from '../hooks-models'

import { DataRefField } from './node-data-panel'
import { field, type NodeInspectorProps } from './node-inspector-shared'

// The Decision inspector.
//
// A Decision node is a small form over two things: WHAT to judge (one data ref,
// exactly like Branch and Switch) and WHICH questions to ask. There is no
// routing control, because the node does not route — a Branch or Switch below it
// reads `answers.<questionId>.value`.
//
// The panel leans on one idea throughout: asking several questions in one node
// is the normal case, not the advanced one. Every question is a row in the same
// list, and the per-question threshold sits inside its own row so the author
// reads "is it urgent? … call it urgent above 0.8" as one sentence. Routing
// living downstream is what keeps that true — a node that also routed could
// serve only one of its questions.
//
// Raw `<input>`/`<select>` rather than the host's injected primitives, for the
// reason the rest of this file does it: `cn` is clsx alone (no tailwind-merge),
// so a className cannot shrink an injected control, and these rows need the
// compact size.

const FIELD =
  'border-input bg-card text-foreground placeholder:text-muted-foreground h-8 w-full rounded-md border px-2 text-xs outline-none focus:border-ring'

const MARKER =
  'border-input bg-muted text-muted-foreground rounded border px-1.5 py-0.5 text-center font-mono text-[11px]'

type Question = DecisionNodeQuestion

/** What each question type is FOR, in the author's terms. */
const TYPE_LABEL: Record<DecisionQuestionType, string> = {
  boolean: 'Yes / no',
  category: 'Pick one',
  scale: 'Rate on a scale',
}

const TYPE_HELP: Record<DecisionQuestionType, string> = {
  boolean:
    'Answered with a probability, and turned into yes/no by the threshold below — so you choose where the line sits, not the model.',
  category:
    'Answered with one of the choices, plus the odds it gave every other one, so a near-tie is visible instead of hidden behind the winner.',
  scale:
    'Answered with a position along the choices, in order — 1.8 on a three-point scale means "between the second and third, nearer the third".',
}

/**
 * A fresh question id: `answer`, `answer_2`, … A starting point, not a fixed
 * name — the author renames it in place, and `renameQuestionId` below carries
 * every reader along. What a minted id guarantees is only that a new question
 * never lands on a name already taken.
 */
function nextQuestionId(existing: readonly Question[]): string {
  const taken = new Set(existing.map((q) => q.id))
  if (!taken.has('answer')) return 'answer'
  for (let i = 2; ; i++) {
    const id = `answer_${i}`
    if (!taken.has(id)) return id
  }
}

function newQuestion(existing: readonly Question[]): Question {
  return {
    id: nextQuestionId(existing),
    type: 'boolean',
    prompt: '',
    choices: [],
  }
}

/** A choice key from a label: `Needs review` → `needs_review`. */
function keyFromLabel(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'option'
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const key = `${base}_${i}`
    if (!taken.has(key)) return key
  }
}

export function DecisionInspector({
  node,
  graph,
  onChange,
  onGraphChange,
  itemSchema,
}: NodeInspectorProps) {
  const { Label } = useWfComponents()
  // Hooks before the kind guard — one can't sit behind an early return.
  const models = useDecisionModels()
  const providers = useDecisionProviders()
  const grouped = useMemo(
    () => groupByProvider(models.data ?? [], providers.data ?? []),
    [models.data, providers.data],
  )
  if (node.kind !== 'decision') return null

  const { modelId, questions } = node.config
  const setConfig = (patch: Partial<DecisionNode['config']>) => {
    return onChange({ ...node, config: { ...node.config, ...patch } })
  }
  const setQuestion = (index: number, patch: Partial<Question>) => {
    return setConfig({
      questions: questions.map((q, i) => (i === index ? { ...q, ...patch } : q)),
    })
  }
  /**
   * Rename a question, and every binding that reads it.
   *
   * The id is an ADDRESS — a Branch downstream holds `answers.<id>.value` — so a
   * rename that touched this node alone would silently strand its readers. The
   * whole graph is rewritten in one undoable step instead: this node's question
   * plus every ref into it, so undo puts both halves back together.
   *
   * Without a graph-level channel (a host embedding the inspector standalone)
   * the rename is refused rather than half-applied.
   */
  const renameQuestion = (index: number, raw: string) => {
    const current = questions[index]
    if (!current || !onGraphChange) return
    // An emptied field is a cleared input, not a request to be called `option`
    // (what `keyFromLabel` falls back to) — so it keeps the name it has.
    if (!raw.trim()) return
    const taken = new Set(
      questions.filter((_, i) => i !== index).map((q) => q.id),
    )
    const id = keyFromLabel(raw, taken)
    if (id === current.id) return
    const renamed: WorkflowGraph = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === node.id
          ? {
              ...node,
              config: {
                ...node.config,
                questions: questions.map((q, i) =>
                  i === index ? { ...q, id } : q,
                ),
              },
            }
          : n,
      ),
    }
    onGraphChange(
      renameGraphRefPaths(renamed, {
        nodeId: node.id,
        from: `answers.${current.id}`,
        to: `answers.${id}`,
      }),
      `Rename question to ${id}`,
    )
  }
  const chosen = (models.data ?? []).find((m) => m.id === modelId)

  return (
    <>
      <div className={field}>
        <Label>Judge with</Label>
        <select
          className={cn(FIELD, 'h-9 text-sm', !modelId && 'border-destructive')}
          value={modelId}
          aria-label="Decision model"
          onChange={(e) => setConfig({ modelId: e.target.value })}
        >
          <option value="">Pick a decision model…</option>
          {grouped.map(({ label, kind, items }) => (
            <optgroup key={label} label={label}>
              {items.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {kind === 'chat-emulated' ? ' (emulated)' : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {/* Whether the numbers are calibrated is not trivia: every threshold on
            this panel is a threshold on them. An emulated decider's confidence
            is a chat model's self-report, and an author setting 0.8 deserves to
            know which kind of 0.8 they just set. */}
        {chosen && chosen.calibrated === false ? (
          <p className="text-muted-foreground text-xs">
            This decider emulates judgments on a chat model. Its probabilities
            are the model’s own estimate rather than a calibrated distribution —
            usable, but treat the thresholds below as rough.
          </p>
        ) : null}
        {(models.data ?? []).length === 0 && !models.isLoading ? (
          <p className="text-muted-foreground text-xs">
            No decision provider is wired up in this deployment, so this node
            cannot run. See <code>WfSdkConfig.getDecider</code>.
          </p>
        ) : null}
      </div>

      <div className={field}>
        <Label>Judge this</Label>
        <DataRefField
          node={node}
          graph={graph}
          value={node.config.source}
          itemSchema={itemSchema}
          onChange={(source) => setConfig({ source })}
        />
        <p className="text-muted-foreground text-xs">
          The value every question is judged against. Leave unset to judge the
          whole incoming input.
        </p>
      </div>

      <div className={field}>
        <Label>Questions</Label>
        {/* All questions go out in ONE request and are judged against the same
            value, which is the whole economy of this node — so the panel makes
            adding a second question the obvious move rather than a new node. */}
        <div className="space-y-2">
          {questions.map((q, i) => (
            <QuestionCard
              key={q.id}
              question={q}
              node={node}
              graph={graph}
              itemSchema={itemSchema}
              model={chosen}
              canRename={onGraphChange != null}
              onRename={(id) => renameQuestion(i, id)}
              onRemove={() => {
                return setConfig({
                  questions: questions.filter((_, j) => j !== i),
                })
              }}
              onChange={(patch) => setQuestion(i, patch)}
            />
          ))}
        </div>
        <button
          type="button"
          className="border-input hover:bg-accent text-muted-foreground hover:text-foreground mt-2 flex w-full items-center justify-center gap-1 rounded-md border border-dashed py-1.5 text-xs"
          onClick={() => {
            return setConfig({ questions: [...questions, newQuestion(questions)] })
          }}
        >
          <Plus className="size-3" /> Add a question
        </button>
        <p className="text-muted-foreground text-xs">
          Every question is judged in one request against the same value, so
          asking five costs the same round trip as asking one. This node only
          answers — route on an answer with a Branch or Switch below it, reading{' '}
          <code>answers.{questions[0]?.id ?? '<question>'}.value</code>. One
          Branch per question, all off this one call.
        </p>
      </div>
    </>
  )
}

function QuestionCard({
  question,
  node,
  graph,
  itemSchema,
  model,
  canRename,
  onRename,
  onRemove,
  onChange,
}: {
  question: Question
  node: DecisionNode
  graph: WorkflowGraph
  itemSchema?: JsonSchema
  model: DecisionModelOption | undefined
  canRename: boolean
  onRename: (id: string) => void
  onRemove: () => void
  onChange: (patch: Partial<Question>) => void
}) {
  const needsChoices = question.type !== 'boolean'
  // Which half of the Options control is showing. Local, not config: "I mean to
  // bind this" is a UI state that exists before there is anything to store, and
  // writing a placeholder binding to say so would put a ref with no nodeId in
  // the graph — which `refBindingSchema` rejects, taking the whole save with it.
  // A bound question is always in upstream mode; an unbound one starts wherever
  // the author left it this session.
  const [wantsBoundChoices, setWantsBoundChoices] = useState(false)
  const boundChoices = question.choicesSource != null || wantsBoundChoices
  const unsupported =
    model != null && !supportsQuestionType(model, question.type)

  const setChoices = (choices: Question['choices']) => onChange({ choices })
  const addChoice = () => {
    const taken = new Set(question.choices.map((c) => c.key))
    return setChoices([
      ...question.choices,
      { key: keyFromLabel('', taken), label: '' },
    ])
  }

  return (
    <div className="border-input space-y-1.5 rounded-md border p-2">
      <div className="flex items-center justify-between gap-2">
        {/* The id is the name AND the address (`answers.<id>.value`), so it is
            edited in place rather than shown as a read-only chip. Committed on
            blur/Enter, not per keystroke: every commit rewrites the readers, and
            doing that mid-word would rename the question to `i`, then `is`, then
            `is_u`. The value is normalised the way a choice key is, so what the
            author types is what downstream bindings can actually address. */}
        <input
          className={cn(MARKER, 'h-6 w-full max-w-[60%] text-left')}
          aria-label={`Name of question ${question.id}`}
          title={
            canRename
              ? 'The name downstream nodes bind to — renaming repoints them'
              : 'Renaming needs the full editor'
          }
          defaultValue={question.id}
          key={question.id}
          disabled={!canRename}
          onBlur={(e) => {
            // An emptied field snaps back to the name it still has, rather than
            // sitting there blank while the question is called something else.
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
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label={`Remove question ${question.id}`}
            className="text-muted-foreground hover:text-foreground hover:bg-accent rounded p-1"
            onClick={onRemove}
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      <Row label="Ask">
        <input
          className={cn(FIELD, !question.prompt.trim() && 'border-destructive')}
          placeholder="Does this need a lawyer to review it?"
          aria-label={`Prompt for ${question.id}`}
          value={question.prompt}
          onChange={(e) => onChange({ prompt: e.target.value })}
        />
      </Row>

      <Row label="Answer">
        <select
          className={cn(FIELD, unsupported && 'border-destructive')}
          aria-label={`Answer type for ${question.id}`}
          value={question.type}
          onChange={(e) => {
            const type = e.target.value as DecisionQuestionType
            return onChange({
              type,
              // A boolean has no choices and a threshold; the others have
              // choices and no threshold. Clearing the irrelevant half on the
              // way through stops a stale value from outliving the type that
              // gave it meaning.
              choices: type === 'boolean' ? [] : question.choices,
              choicesSource:
                type === 'boolean' ? undefined : question.choicesSource,
              threshold: type === 'boolean' ? question.threshold : undefined,
            })
          }}
        >
          {DECISION_QUESTION_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </Row>
      <p className="text-muted-foreground pl-[72px] text-[11px]">
        {unsupported
          ? `This decider can’t answer “${TYPE_LABEL[question.type]}” questions — pick another type or another model.`
          : TYPE_HELP[question.type]}
      </p>

      {question.type === 'boolean' ? (
        <Row label="Yes above">
          <input
            className={cn(FIELD, 'w-20')}
            type="number"
            min={0}
            max={1}
            step={0.05}
            placeholder="0.5"
            aria-label={`Threshold for ${question.id}`}
            value={question.threshold ?? ''}
            onChange={(e) => {
              const raw = e.target.value
              return onChange({
                threshold: raw === '' ? undefined : Number(raw),
              })
            }}
          />
        </Row>
      ) : null}

      {needsChoices ? (
        <div className="space-y-1.5">
          {/* Where the options come from. "Written here" is the common case and
              stays the default; "From a list upstream" is for the question that
              cannot be authored — "which of these documents is the lease", where
              the documents are whatever the run found. One or the other, never
              both: a merged list would leave the author guessing which half the
              model was actually choosing between. */}
          <Row label="Options">
            <select
              className={cn(FIELD, 'h-7')}
              aria-label={`Where the choices for ${question.id} come from`}
              value={boundChoices ? 'upstream' : 'fixed'}
              onChange={(e) => {
                const upstream = e.target.value === 'upstream'
                setWantsBoundChoices(upstream)
                // Leaving upstream mode drops the binding; entering it keeps the
                // authored list untouched, so flipping back and forth to compare
                // does not cost the author their options.
                if (!upstream && question.choicesSource) {
                  onChange({ choicesSource: undefined })
                }
              }}
            >
              <option value="fixed">Written here</option>
              <option value="upstream">From a list upstream</option>
            </select>
          </Row>
          {boundChoices ? (
            <>
              <Row label="List">
                <DataRefField
                  node={node}
                  graph={graph}
                  value={question.choicesSource}
                  itemSchema={itemSchema}
                  onChange={(choicesSource) => onChange({ choicesSource })}
                />
              </Row>
              <p className="text-muted-foreground pl-[72px] text-[11px]">
                {question.type === 'scale'
                  ? 'The array becomes the scale, in the order it arrives. Each item is a string, or an object with a key or label.'
                  : 'Each item in the array becomes an option: a string, or an object with a key or label (and an optional description).'}{' '}
                The run fails if fewer than two arrive.
              </p>
            </>
          ) : null}
          {boundChoices ? null : (
          <div className="text-muted-foreground pl-[72px] text-[11px]">
            {question.type === 'scale'
              ? 'In order, lowest first — the order is the scale.'
              : 'The options to choose between.'}
          </div>
          )}
          {boundChoices ? null : question.choices.map((choice, i) => (
            <Row key={i} label={question.type === 'scale' ? `${i}` : '·'}>
              <div className="flex items-center gap-1">
                <input
                  className={FIELD}
                  placeholder={
                    question.type === 'scale' ? 'Needs attention today' : 'Billing'
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
                    // The key is derived from the label only while the author
                    // hasn't leaned on it yet — once an edge is drawn against a
                    // key, renaming the label must not re-point it. A key that is
                    // still the derived form of the old label is safe to re-derive;
                    // anything else is left alone.
                    const stillDerived =
                      choice.key ===
                      keyFromLabel(choice.label ?? '', new Set())
                    return setChoices(
                      question.choices.map((c, j) =>
                        j === i
                          ? {
                              ...c,
                              label,
                              key: stillDerived
                                ? keyFromLabel(label, taken)
                                : c.key,
                            }
                          : c,
                      ),
                    )
                  }}
                />
                <span className={cn(MARKER, 'shrink-0')}>{choice.key}</span>
                <button
                  type="button"
                  aria-label={`Remove choice ${choice.key}`}
                  className="text-muted-foreground hover:text-foreground hover:bg-accent shrink-0 rounded p-1"
                  onClick={() => {
                    return setChoices(question.choices.filter((_, j) => j !== i))
                  }}
                >
                  <X className="size-3" />
                </button>
              </div>
            </Row>
          ))}
          {boundChoices ? null : (
            <div className="pl-[72px]">
              <button
                type="button"
                className="border-input hover:bg-accent text-muted-foreground hover:text-foreground flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-[11px]"
                onClick={addChoice}
              >
                <Plus className="size-3" />
                {question.type === 'scale' ? 'Add a level' : 'Add an option'}
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-muted-foreground w-16 shrink-0 text-right text-[11px]">
        {label}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  )
}

/**
 * Models under their provider headings, in the providers' declared order, with
 * anything whose provider the host no longer declares gathered under "Other" —
 * dropping those silently would leave an author's saved node pointing at a model
 * that has vanished from its own picker.
 */
function groupByProvider(
  models: readonly DecisionModelOption[],
  providers: readonly { id: string; label: string; kind: string }[],
): { label: string; kind: string; items: DecisionModelOption[] }[] {
  const groups = providers.map((p) => ({
    label: p.label,
    kind: p.kind,
    items: models.filter((m) => m.providerId === p.id),
  }))
  const known = new Set(providers.map((p) => p.id))
  const orphans = models.filter(
    (m) => m.providerId == null || !known.has(m.providerId),
  )
  if (orphans.length > 0) {
    groups.push({ label: 'Other', kind: 'custom', items: orphans })
  }
  return groups.filter((g) => g.items.length > 0)
}
