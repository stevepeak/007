import { Sparkles, X } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import {
  branchOperatorTakesValue,
  ITERATION_MAX_ITEMS_CEILING,
  TRANSFORM_OUTPUT_SHAPES,
  nextSwitchCaseKey,
  SWITCH_DEFAULT_CASE,
  type ArgBinding,
  type IterationItemExecution,
  type SwitchNode,
  type TransformOutputShape,
} from '../../engine'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import { askCopilot, useCopilotSeedAvailable } from '../copilot/ask'
import { toText } from '../to-text'

import { BranchOperatorSelect } from './branch-operator-select'
import { DataRefField, IterationListField } from './node-data-panel'
import { useAccessibleData } from './node-data-panel-shared'
import { field, type NodeInspectorProps } from './node-inspector-shared'
import { refEnumOptions, transformSourceShape } from './node-io'
import { buildTransformCopilotPrompt } from './transform-copilot-prompt'

// What the choice means for the author, in their terms. The trade is per-item
// startup cost against how much work is lost when one item fails partway — and
// the right answer depends on list length, which only the author knows.
// What `concurrency` bounds depends on the item execution: inline items share
// the parent run's budget, durable items each have their own and the parent just
// waits. The number means the same thing either way — "at most this many at
// once" — but the REASON to pick one changes, so the help text does too.
const CONCURRENCY_HELP: Record<IterationItemExecution, string> = {
  inline:
    'How many items run at once (1–20). They share this run’s budget, so this is what stops a long list from exhausting it. 1 runs them one at a time.',
  durable:
    'How many items run at once (1–20). Each item is its own run with its own budget, so this isn’t about this run’s limits — it throttles what the items call out to, like a model provider’s rate limit. 1 runs them one at a time.',
}

const STOP_ON_ERROR_HELP: Record<IterationItemExecution, string> = {
  inline:
    'When off, a failed item is recorded and the rest keep running; the output collects a placeholder in that item’s slot.',
  durable:
    'When off, a failed item is recorded and the rest keep running; the output collects a placeholder in that item’s slot. When on, no further items start, but items already running are left to finish before the loop fails — stopping one partway would leave its work half-written.',
}

const ITEM_EXECUTION_HELP: Record<IterationItemExecution, string> = {
  inline:
    'Each item runs as a single all-or-nothing unit. Cheapest per item, so it suits long lists over small subgraphs — but if an item fails partway it repeats from the start, and the inner steps’ own timeout and retry settings do not apply.',
  durable:
    'Each item runs as its own checkpointed run, so every inner step retries and times out on its own terms — a step that fails is retried by itself instead of repeating the whole item. Costs one run start per item, so it suits shorter lists over real pipelines. Each item also gets a run of its own you can open from the loop and inspect.',
}

export function BranchInspector({
  node,
  graph,
  onChange,
  itemSchema,
}: NodeInspectorProps) {
  const { Input, Label } = useWfComponents()
  // Called before the kind guard, because a hook can't sit behind an early
  // return. When the tested value declares an enum, the operand is one OF those
  // values, so the box becomes a picker of them rather than a spelling test.
  const { accessible } = useAccessibleData(node, graph, itemSchema)
  const branchSource = node.kind === 'branch' ? node.config.source : undefined
  const options = useMemo(
    () => refEnumOptions(accessible, branchSource),
    [accessible, branchSource],
  )
  if (node.kind !== 'branch') return null
  return (
    <>
      <div className={field}>
        <Label>Input</Label>
        <DataRefField
          node={node}
          graph={graph}
          value={node.config.source}
          itemSchema={itemSchema}
          onChange={(source) =>
            onChange({
              ...node,
              config: { ...node.config, source },
            })
          }
        />
        <p className="text-muted-foreground text-xs">
          Connect the upstream value to test. Leave unset to test the whole
          incoming input.
        </p>
      </div>
      <div className={field}>
        <Label>Condition</Label>
        {/* Operator + operand on ONE row: they're two halves of one sentence
            ("kind = image"), and the operator collapses to its glyph so the
            operand gets the width instead. */}
        <div className="flex items-center gap-1.5">
          <BranchOperatorSelect
            value={node.config.operator}
            onChange={(operator) =>
              onChange({ ...node, config: { ...node.config, operator } })
            }
          />
          {branchOperatorTakesValue(node.config.operator) ? (
            <div className="min-w-0 flex-1">
              {options ? (
                <select
                  className="border-input bg-card text-foreground focus:border-ring h-9 w-full rounded-md border px-2 text-sm outline-none"
                  value={scalarText(node.config.value)}
                  onChange={(e) => {
                    // Round-tripped through the declared options so a numeric or
                    // boolean enum keeps its type instead of being stored as its
                    // text form.
                    const picked = options.find(
                      (o) => toText(o) === e.target.value,
                    )
                    onChange({
                      ...node,
                      config: { ...node.config, value: picked ?? '' },
                    })
                  }}
                >
                  <option value="">value…</option>
                  {options.map((o) => (
                    <option key={toText(o)} value={toText(o)}>
                      {toText(o)}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  placeholder="value…"
                  value={scalarText(node.config.value)}
                  onChange={(e) =>
                    onChange({
                      ...node,
                      config: { ...node.config, value: e.target.value },
                    })
                  }
                />
              )}
            </div>
          ) : (
            <p className="text-muted-foreground flex-1 text-xs">
              Tests the value on its own — nothing to compare against.
            </p>
          )}
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        Deterministic — no model call. The <strong>yes</strong> edge is
        taken when the condition holds.
      </p>
    </>
  )
}

export function OutputInspector({
  node,
  graph,
  onChange,
  itemSchema,
}: NodeInspectorProps) {
  if (node.kind !== 'output') return null
  return (
    <div className={field}>
      <DataRefField
        node={node}
        graph={graph}
        value={node.config.source}
        itemSchema={itemSchema}
        onChange={(source) =>
          onChange({
            ...node,
            config: { ...node.config, source },
          })
        }
      />
      <p className="text-muted-foreground text-xs">
        Pick the upstream value the user receives.
      </p>
    </div>
  )
}

// What an authored value shows in its text box. Only a scalar has a sensible
// text form — an object (which no picker in these editors produces) reads as
// empty rather than as '[object Object]'.
function scalarText(value: unknown): string {
  return toText(value)
}

function literalText(binding: ArgBinding): string {
  return binding.kind === 'literal' ? scalarText(binding.value) : ''
}

// The compact fields inside a case card are RAW elements, not the injected
// `Input`/`Select`. Those carry their own `h-9 px-3 text-sm`, and `cn` is plain
// clsx with no tailwind-merge, so a className can't shrink them — whichever
// class Tailwind happens to emit later wins, which is how a "text-xs" box kept
// rendering full size. Styled here to match the data connector above it.
const CASE_FIELD =
  'border-input bg-card text-foreground placeholder:text-muted-foreground h-8 w-full rounded-md border px-2 text-xs outline-none focus:border-ring'

// The routing key, as a quiet badge — the letter an outgoing edge is actually
// keyed on. Shared by the case cards and the `else` fallback so the two read as
// the same kind of thing.
const CASE_MARKER =
  'border-input bg-muted text-muted-foreground rounded border px-1.5 py-0.5 text-center font-mono text-[11px]'

// The Switch inspector. A Switch has exactly ONE data connection — the input,
// picked with the same data picker every other node uses — and each case is a
// value that input is compared against, so a case is a plain field (a dropdown
// when the input declares an enum), never a second picker.
//
// Each case's key is minted as a letter (A, B, C…) and never re-lettered, so an
// edge stays pointed where the author put it. The author names the path
// separately, and the name is what the canvas edge reads, so a graph says
// 'image' rather than 'A'.
type SwitchCase = SwitchNode['config']['cases'][number]

/**
 * Appends cases, minting each key against the ones already present PLUS the ones
 * this call has already minted — a key is an edge identity, so two arms added in
 * one click must not collide.
 */
function appendCases(
  cases: readonly SwitchCase[],
  added: { value: unknown; label?: string }[],
): SwitchCase[] {
  const next = [...cases]
  for (const a of added) {
    next.push({
      key: nextSwitchCaseKey(next.map((c) => c.key)),
      label: a.label,
      value: { kind: 'literal', value: a.value },
    })
  }
  return next
}

export function SwitchInspector({
  node,
  graph,
  onChange,
  itemSchema,
}: NodeInspectorProps) {
  const { Label } = useWfComponents()
  // Called before the kind guard, because a hook can't sit behind an early
  // return. When the matched value declares an enum, the case list stops being
  // free authoring and becomes a checklist over the declared values.
  const { accessible } = useAccessibleData(node, graph, itemSchema)
  const switchSource = node.kind === 'switch' ? node.config.source : undefined
  const options = useMemo(
    () => refEnumOptions(accessible, switchSource),
    [accessible, switchSource],
  )
  if (node.kind !== 'switch') return null

  const cases = node.config.cases
  const setCases = (next: SwitchCase[]) =>
    onChange({ ...node, config: { ...node.config, cases: next } })
  const setCase = (index: number, patch: Partial<SwitchCase>) =>
    setCases(cases.map((c, i) => (i === index ? { ...c, ...patch } : c)))
  // Which declared options no case covers yet — what the "add the rest" button
  // offers, so an author never retypes a value the schema already spells out.
  const covered = new Set(
    cases.map((c) => (c.value.kind === 'literal' ? toText(c.value.value) : '')),
  )
  const uncovered = (options ?? []).filter((o) => !covered.has(toText(o)))

  return (
    <>
      <div className={field}>
        <Label>Input</Label>
        {/* The ONE data connection this node has. Every case below is a value
            this is compared against — there is nothing else here to link, which
            is why the case rows are plain fields and not pickers. */}
        <DataRefField
          node={node}
          graph={graph}
          value={node.config.source}
          itemSchema={itemSchema}
          onChange={(source) =>
            onChange({ ...node, config: { ...node.config, source } })
          }
        />
        <p className="text-muted-foreground text-xs">
          The value every case is matched against. Leave unset to match the whole
          incoming input.
        </p>
      </div>
      <div className={field}>
        <Label>Cases</Label>
        {/* One card per case, each a labelled two-row form. The stacked layout is
            what makes the two fields tell themselves apart: side by side, a name
            box showing the routing letter reads like a value. */}
        <div className="space-y-2">
          {cases.map((c, i) => (
          <CaseCard
            key={c.key}
            caseKey={c.key}
            onRemove={() => setCases(cases.filter((_, j) => j !== i))}
            removeLabel={`Remove case ${c.label?.trim() || c.key}`}
          >
            <CaseRow label="Path name">
              {/* The badge above is the routing key and never changes; this names
                  the path, and the name is what the canvas edge reads. */}
              <input
                className={CASE_FIELD}
                value={c.label ?? ''}
                placeholder={c.key}
                aria-label={`Name for case ${c.key}`}
                // An emptied name drops the field rather than storing '', so the
                // path falls back to its letter instead of rendering blank.
                onChange={(e) =>
                  setCase(i, { label: e.target.value || undefined })
                }
              />
            </CaseRow>
            <CaseRow label="Value">
              {c.value.kind === 'ref' ? (
                // Legacy: a case authored when a case could point at a second
                // upstream value. Still honoured at run time, still clearable —
                // just not something the editor offers to create any more.
                <div className="border-input flex h-8 items-center gap-1 rounded-md border pr-0.5 pl-2">
                  <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                    {c.value.nodeId} · {c.value.path || 'whole output'}
                  </span>
                  <button
                    type="button"
                    aria-label={`Unlink case ${c.label?.trim() || c.key}`}
                    className="text-muted-foreground hover:text-foreground hover:bg-accent shrink-0 rounded p-1"
                    onClick={() =>
                      setCase(i, { value: { kind: 'literal', value: '' } })
                    }
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ) : options ? (
                // An enum input: the case is a choice among the declared values,
                // so there is nothing to spell and nothing to mistype.
                <select
                  className={cn(CASE_FIELD, isBlankCase(c) && 'border-destructive')}
                  aria-label={`Value for case ${c.label?.trim() || c.key}`}
                  value={literalText(c.value)}
                  onChange={(e) =>
                    setCase(i, {
                      value: {
                        kind: 'literal',
                        // Round-tripped through the options so a numeric or
                        // boolean enum keeps its type.
                        value:
                          options.find((o) => toText(o) === e.target.value) ??
                          '',
                      },
                    })
                  }
                >
                  <option value="">Select a value…</option>
                  {options.map((o) => (
                    <option key={toText(o)} value={toText(o)}>
                      {toText(o)}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className={cn(CASE_FIELD, isBlankCase(c) && 'border-destructive')}
                  value={literalText(c.value)}
                  placeholder="the input equals…"
                  aria-label={`Value for case ${c.label?.trim() || c.key}`}
                  onChange={(e) =>
                    setCase(i, {
                      value: { kind: 'literal', value: e.target.value },
                    })
                  }
                />
              )}
            </CaseRow>
            </CaseCard>
          ))}
          {/* The fallback wears the same card so it reads as the last case in
              the list, but dashed and unfillable — nothing to author on it. */}
          <div className="border-input flex items-center gap-2 rounded-md border border-dashed px-2 py-2">
            <span className={cn(CASE_MARKER, 'shrink-0')}>
              {SWITCH_DEFAULT_CASE}
            </span>
            <p className="text-muted-foreground min-w-0 flex-1 text-xs">
              Anything the cases above didn’t match.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <button
            type="button"
            className="border-input hover:bg-accent rounded-md border px-2 py-1 text-xs"
            onClick={() => setCases(appendCases(cases, [{ value: '' }]))}
          >
            + Add case
          </button>
          {uncovered.length > 0 ? (
            <button
              type="button"
              className="border-input hover:bg-accent rounded-md border px-2 py-1 text-xs"
              onClick={() =>
                setCases(
                  appendCases(
                    cases,
                    uncovered.map((o) => ({ value: o, label: toText(o) })),
                  ),
                )
              }
            >
              + Add the {uncovered.length} remaining option
              {uncovered.length > 1 ? 's' : ''}
            </button>
          ) : null}
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        Deterministic — no model call. The input above is compared against each
        case’s value in order and the first match wins; a value matching none
        takes the <strong>else</strong> edge. A case’s name is only what its
        canvas edge reads — the routing key stays the letter on the card.
      </p>
    </>
  )
}

// A case the author added but never filled in. Flagged here as well as in the
// graph's issue list, because "case A has no value" means nothing until the row
// it refers to is the one wearing the red border.
function isBlankCase(c: SwitchCase): boolean {
  return (
    c.value.kind === 'literal' && (c.value.value == null || c.value.value === '')
  )
}

// One case, as a card: its routing letter, its remove control, and its two
// labelled fields.
function CaseCard({
  caseKey,
  onRemove,
  removeLabel,
  children,
}: {
  caseKey: string
  onRemove: () => void
  removeLabel: string
  children: ReactNode
}) {
  return (
    <div className="border-input space-y-1.5 rounded-md border p-2">
      <div className="flex items-center justify-between">
        <span className={CASE_MARKER}>{caseKey}</span>
        <button
          type="button"
          aria-label={removeLabel}
          className="text-muted-foreground hover:text-foreground hover:bg-accent rounded p-1"
          onClick={onRemove}
        >
          <X className="size-3.5" />
        </button>
      </div>
      {children}
    </div>
  )
}

// A labelled field inside a case card. The label column is fixed so the two
// fields line up down the card and the eye can read one column of names.
function CaseRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-muted-foreground w-16 shrink-0 text-[11px]">
        {label}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  )
}

export function IterationInspector({
  node,
  graph,
  onChange,
  itemSchema,
}: NodeInspectorProps) {
  const { Input, Label, Checkbox, Select } = useWfComponents()
  if (node.kind !== 'iteration') return null
  return (
    <>
      <div className={field}>
        <Label>List</Label>
        <IterationListField
          node={node}
          graph={graph}
          value={node.config.source}
          itemSchema={itemSchema}
          onSelect={(source, elemSchema) =>
            onChange({
              ...node,
              config: {
                ...node.config,
                source,
                itemSchema: elemSchema,
              },
            })
          }
        />
        <p className="text-muted-foreground text-xs">
          Drill into any upstream node's data and pick the{' '}
          <strong>list</strong> to loop over — each element becomes the{' '}
          <strong>Item</strong>. Only arrays can be selected.
        </p>
      </div>
      <div className={field}>
        <Label>Concurrency</Label>
        <Input
          type="number"
          min={1}
          max={20}
          value={String(node.config.concurrency)}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10)
            onChange({
              ...node,
              config: {
                ...node.config,
                concurrency: Number.isNaN(n)
                  ? 1
                  : Math.min(20, Math.max(1, n)),
              },
            })
          }}
        />
        <p className="text-muted-foreground text-xs">
          {CONCURRENCY_HELP[node.config.itemExecution]}
        </p>
      </div>
      <div className={field}>
        <Label>Item execution</Label>
        <Select
          value={node.config.itemExecution}
          onChange={(e) =>
            onChange({
              ...node,
              config: {
                ...node.config,
                itemExecution: e.target.value as IterationItemExecution,
              },
            })
          }
        >
          <option value="inline">Inline (whole item as one step)</option>
          <option value="durable">Durable (one run per item)</option>
        </Select>
        <p className="text-muted-foreground text-xs">
          {ITEM_EXECUTION_HELP[node.config.itemExecution]}
        </p>
      </div>
      <div className={field}>
        <Label>Max items</Label>
        <Input
          type="number"
          min={1}
          max={ITERATION_MAX_ITEMS_CEILING[node.config.itemExecution]}
          // Empty means UNSET, which is a real state (the Issues panel calls it
          // an error) and not the same as zero — so a cleared field clears the
          // bound rather than silently snapping back to a default.
          value={
            node.config.maxItems === undefined
              ? ''
              : String(node.config.maxItems)
          }
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10)
            onChange({
              ...node,
              config: {
                ...node.config,
                maxItems: Number.isNaN(n) ? undefined : Math.max(1, n),
              },
            })
          }}
        />
        <p className="text-muted-foreground text-xs">
          The most items this loop will ever run. A longer list fails the node
          outright — nothing is truncated, so a bad list can’t look like a
          finished one. Up to{' '}
          {ITERATION_MAX_ITEMS_CEILING[node.config.itemExecution]} on{' '}
          {node.config.itemExecution} item execution.
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={node.config.stopOnError}
          onChange={(e) =>
            onChange({
              ...node,
              config: { ...node.config, stopOnError: e.target.checked },
            })
          }
        />
        Stop on first error
      </label>
      <p className="text-muted-foreground text-xs">
        {STOP_ON_ERROR_HELP[node.config.itemExecution]}
      </p>
      <p className="text-muted-foreground text-xs">
        Drag nodes into the block on the canvas to run them per item. The{' '}
        <strong>Item</strong> node is the current element; the{' '}
        <strong>Result</strong> node is that item's output.
      </p>
    </>
  )
}

type PassthroughMode = 'identity' | 'value' | 'fields'

// A ref-picker with a literal-text fallback: pick an upstream value, or type a
// literal when no ref is bound. Both Passthrough modes (single value, object
// field) share this exact control. Deliberately NOT the richer `BindingField`
// from node-data-panel-inputs — that one adds type coercion, enum selects, and a
// "Set" button, which the Passthrough editor doesn't want.
function RefOrLiteralField({
  node,
  graph,
  itemSchema,
  binding,
  onChange,
}: Pick<NodeInspectorProps, 'node' | 'graph' | 'itemSchema'> & {
  binding: ArgBinding | undefined
  onChange: (binding: ArgBinding | undefined) => void
}) {
  const { Input } = useWfComponents()
  return (
    <>
      <DataRefField
        node={node}
        graph={graph}
        value={binding?.kind === 'ref' ? binding : undefined}
        itemSchema={itemSchema}
        onChange={onChange}
      />
      {binding?.kind !== 'ref' ? (
        <Input
          value={binding?.kind === 'literal' ? toText(binding.value) : ''}
          placeholder="or a literal value…"
          onChange={(e) => onChange({ kind: 'literal', value: e.target.value })}
        />
      ) : null}
    </>
  )
}

// What declaring an output shape buys, in the author's terms. The cost of NOT
// declaring one is paid late and far away — inside the AI SDK, after a retry
// schedule — so the help text has to earn the checkbox here.
const OUTPUT_SHAPE_HELP: Record<TransformOutputShape, string> = {
  conversation:
    'Checks the result really is a list of messages before an agent sees it. Worth setting: an agent only verifies that its conversation is an array, so a wrong shape fails deep inside the model call instead of here.',
}

// The Transform inspector. A Transform reworks a value with a JSONata
// expression — the one place in the graph where data changes shape rather than
// merely being addressed, which is what a boundary between two disagreeing
// contracts needs (database records in, agent messages out).
export function TransformInspector({
  node,
  graph,
  onChange,
  itemSchema,
}: NodeInspectorProps) {
  const { Label, Select, Textarea } = useWfComponents()
  // Resolving the upstream shape needs the tool/agent catalogs, so these hooks
  // run before the kind guard below — hooks cannot sit after an early return.
  const { maps } = useAccessibleData(node, graph, itemSchema)
  const copilotAvailable = useCopilotSeedAvailable()
  const sourceShape = useMemo(
    () => transformSourceShape(node, graph, maps),
    [node, graph, maps],
  )
  if (node.kind !== 'transform') return null

  const { source, inputs, expression, outputShape } = node.config
  const entries = Object.entries(inputs)

  // Hand the Copilot the question already written, carrying the real shape of
  // the data this step will receive. Writing JSONata against a remembered field
  // list is the slow, error-prone part; the editor already knows that list.
  const askForExpression = () =>
    askCopilot(
      buildTransformCopilotPrompt({
        nodeLabel: node.label || 'Transform',
        sourceLabel: sourceShape?.label ?? null,
        sourceFields: sourceShape?.fields ?? [],
        sourceType: sourceShape?.type ?? 'unknown',
        outputShape,
        currentExpression: expression,
      }),
    )

  const patch = (config: Partial<typeof node.config>) =>
    onChange({ ...node, config: { ...node.config, ...config } })

  const setInputs = (next: Record<string, ArgBinding>) => patch({ inputs: next })

  // Rename a variable by index, preserving order and the bound value.
  const renameInput = (index: number, nextKey: string) => {
    const next: Record<string, ArgBinding> = {}
    for (const [i, [k, v]] of entries.entries()) {
      next[i === index ? nextKey : k] = v
    }
    setInputs(next)
  }

  return (
    <>
      <div className={field}>
        <Label>Input</Label>
        <RefOrLiteralField
          node={node}
          graph={graph}
          itemSchema={itemSchema}
          binding={source}
          onChange={(binding) => patch({ source: binding })}
        />
        <p className="text-muted-foreground text-xs">
          The value the expression runs over, written as <code>$</code>. Leave it
          unset to use whatever the incoming step produced.
        </p>
      </div>

      <div className={field}>
        <Label>Expression</Label>
        <Textarea
          className="font-mono text-xs"
          rows={8}
          spellCheck={false}
          value={expression}
          placeholder={'[$.{\n  "role": role,\n  "parts": [{ "type": "text", "text": body }]\n}]'}
          onChange={(e) => patch({ expression: e.target.value })}
        />
        <p className="text-muted-foreground text-xs">
          JSONata. <code>$</code> is the input above; any extra values below are{' '}
          <code>$name</code>. A result with one element still needs the outer{' '}
          <code>[ ]</code> — without it JSONata returns the bare element instead
          of a list.
        </p>
        {copilotAvailable ? (
          <button
            type="button"
            onClick={askForExpression}
            className="inline-flex w-fit items-center gap-1.5 text-xs text-violet-600 underline underline-offset-2 hover:text-violet-700"
          >
            <Sparkles className="size-3" />
            {expression.trim()
              ? 'Ask the Copilot to fix this expression'
              : 'Ask the Copilot to write this expression'}
          </button>
        ) : null}
      </div>

      <div className={field}>
        <Label>Emits</Label>
        <Select
          value={outputShape ?? ''}
          onChange={(e) =>
            patch({
              outputShape:
                e.target.value === ''
                  ? undefined
                  : (e.target.value as TransformOutputShape),
            })
          }
        >
          <option value="">Anything (not checked)</option>
          {TRANSFORM_OUTPUT_SHAPES.map((shape) => (
            <option key={shape} value={shape}>
              {shape}
            </option>
          ))}
        </Select>
        {outputShape ? (
          <p className="text-muted-foreground text-xs">
            {OUTPUT_SHAPE_HELP[outputShape]}
          </p>
        ) : null}
      </div>

      <div className={field}>
        <Label>Extra values</Label>
        {entries.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            Optional. Add one to pull in a second upstream node without a join
            in front of this one.
          </p>
        ) : null}
        {entries.map(([key, binding], i) => (
          <TransformInputRow
            key={i}
            node={node}
            graph={graph}
            itemSchema={itemSchema}
            name={key}
            binding={binding}
            onRename={(next) => renameInput(i, next)}
            onBind={(next) => setInputs({ ...inputs, [key]: next })}
            onRemove={() =>
              setInputs(
                Object.fromEntries(entries.filter((_, j) => j !== i)),
              )
            }
          />
        ))}
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground w-fit text-xs underline"
          onClick={() =>
            setInputs({ ...inputs, '': { kind: 'literal', value: '' } })
          }
        >
          Add a value
        </button>
      </div>
    </>
  )
}

// One `$name` → binding row. Split out so the variable name and its ref picker
// stay adjacent; the name is what the expression actually types, so it reads as
// the label rather than as an afterthought.
function TransformInputRow({
  node,
  graph,
  itemSchema,
  name,
  binding,
  onRename,
  onBind,
  onRemove,
}: Pick<NodeInspectorProps, 'node' | 'graph' | 'itemSchema'> & {
  name: string
  binding: ArgBinding
  onRename: (next: string) => void
  onBind: (next: ArgBinding) => void
  onRemove: () => void
}) {
  const { Input } = useWfComponents()
  return (
    <div className="flex flex-col gap-1 rounded border p-2">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground font-mono text-xs">$</span>
        <Input
          value={name}
          placeholder="name"
          onChange={(e) => onRename(e.target.value)}
        />
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground text-xs"
          onClick={onRemove}
          aria-label={`Remove ${name || 'value'}`}
        >
          Remove
        </button>
      </div>
      <RefOrLiteralField
        node={node}
        graph={graph}
        itemSchema={itemSchema}
        binding={binding}
        onChange={(next) => onBind(next ?? { kind: 'literal', value: '' })}
      />
    </div>
  )
}

// The Passthrough inspector. A Passthrough re-shapes data so a converging branch
// arm can hand a Race the SAME shape as its sibling. Three modes:
//   • identity — forward the input untouched (no config).
//   • value    — emit ONE binding, unwrapped (match a sibling that emits a bare
//                value, e.g. a string).
//   • fields   — build an object, one key per binding (match `{ name }`/`{ kind }`).
export function PassthroughInspector({
  node,
  graph,
  onChange,
  itemSchema,
}: NodeInspectorProps) {
  const { Input, Label, Select } = useWfComponents()
  const isPassthrough = node.kind === 'passthrough'
  const cfg = isPassthrough ? node.config : undefined
  const initialMode: PassthroughMode = cfg?.value
    ? 'value'
    : cfg?.fields && Object.keys(cfg.fields).length > 0
      ? 'fields'
      : 'identity'
  const [mode, setMode] = useState<PassthroughMode>(initialMode)
  if (node.kind !== 'passthrough') return null

  const value = node.config.value
  const fields = node.config.fields ?? {}
  const entries = Object.entries(fields)

  // Switching mode clears the other slot so the schema's "value XOR fields" rule
  // always holds and stale config never lingers.
  const changeMode = (next: PassthroughMode) => {
    setMode(next)
    if (next === 'identity') onChange({ ...node, config: {} })
    else if (next === 'value')
      onChange({ ...node, config: { value: node.config.value } })
    else onChange({ ...node, config: { fields: node.config.fields ?? {} } })
  }

  const setFields = (nextFields: Record<string, ArgBinding>) =>
    onChange({ ...node, config: { fields: nextFields } })

  // Rename a field key by index, preserving order and the bound value.
  const renameField = (index: number, nextKey: string) => {
    const next: Record<string, ArgBinding> = {}
    for (const [i, [k, v]] of entries.entries()) {
      next[i === index ? nextKey : k] = v
    }
    setFields(next)
  }

  // Set a field's binding. Clearing the ref reverts it to an empty literal so the
  // row stays a valid ArgBinding (a field can't exist unbound).
  const setFieldBinding = (key: string, binding: ArgBinding) => {
    setFields({ ...fields, [key]: binding })
  }

  const removeField = (index: number) =>
    setFields(
      Object.fromEntries(entries.filter((_, i) => i !== index)),
    )

  const addField = () =>
    setFields({ ...fields, '': { kind: 'literal', value: '' } })

  return (
    <>
      <div className={field}>
        <Label>Mode</Label>
        <Select
          value={mode}
          onChange={(e) => changeMode(e.target.value as PassthroughMode)}
        >
          <option value="identity">Pass input through</option>
          <option value="value">Single value</option>
          <option value="fields">Build an object</option>
        </Select>
      </div>

      {mode === 'identity' ? (
        <p className="text-muted-foreground text-xs">
          Forwards the incoming input unchanged — a plain identity step.
        </p>
      ) : null}

      {mode === 'value' ? (
        <div className={field}>
          <Label>Value</Label>
          <RefOrLiteralField
            node={node}
            graph={graph}
            itemSchema={itemSchema}
            binding={value}
            onChange={(next) => onChange({ ...node, config: { value: next } })}
          />
          <p className="text-muted-foreground text-xs">
            Emitted <strong>unwrapped</strong> — use when the sibling arm
            produces a bare value (a string, a number, an array).
          </p>
        </div>
      ) : null}

      {mode === 'fields' ? (
        <div className={field}>
          <Label>Fields</Label>
          {entries.map(([key, binding], i) => (
            <div
              key={i}
              className="space-y-1.5 rounded-md border border-input p-2"
            >
              <div className="flex items-center gap-1.5">
                <Input
                  value={key}
                  placeholder="field name"
                  onChange={(e) => renameField(i, e.target.value)}
                />
                <button
                  type="button"
                  aria-label="Remove field"
                  className="text-muted-foreground hover:text-foreground shrink-0 rounded px-1.5 py-1 text-xs"
                  onClick={() => removeField(i)}
                >
                  ✕
                </button>
              </div>
              <RefOrLiteralField
                node={node}
                graph={graph}
                itemSchema={itemSchema}
                binding={binding}
                onChange={(next) =>
                  setFieldBinding(key, next ?? { kind: 'literal', value: '' })
                }
              />
            </div>
          ))}
          <button
            type="button"
            className="border-input hover:bg-accent self-start rounded-md border px-2 py-1 text-xs"
            onClick={addField}
          >
            + Add field
          </button>
          <p className="text-muted-foreground text-xs">
            Builds an object — one key per field. Point each at the upstream
            value that holds it, so this arm matches a sibling like an agent that
            emits <code>{'{ name }'}</code>.
          </p>
        </div>
      ) : null}
    </>
  )
}
