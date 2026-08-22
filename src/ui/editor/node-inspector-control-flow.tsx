import { Sparkles } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import {
  branchOperatorTakesValue,
  ITERATION_MAX_ITEMS_CEILING,
  TRANSFORM_OUTPUT_SHAPES,
  nextSwitchCaseKey,
  SWITCH_DEFAULT_CASE,
  type ArgBinding,
  type IterationItemExecution,
  type TransformOutputShape,
} from '../../engine'
import { useWfComponents } from '../context'
import { askCopilot, useCopilotSeedAvailable } from '../copilot/ask'
import { toText } from '../to-text'

import { BranchOperatorSelect } from './branch-operator-select'
import { DataRefField, IterationListField } from './node-data-panel'
import { useAccessibleData } from './node-data-panel-shared'
import { field, type NodeInspectorProps } from './node-inspector-shared'
import { transformSourceShape } from './node-io'
import { buildTransformCopilotPrompt } from './transform-copilot-prompt'

// What the choice means for the author, in their terms. The trade is per-item
// startup cost against how much work is lost when one item fails partway — and
// the right answer depends on list length, which only the author knows.
const ITEM_EXECUTION_HELP: Record<IterationItemExecution, string> = {
  inline:
    'Each item runs as a single all-or-nothing unit. Cheapest per item, so it suits long lists over small subgraphs — but if an item fails partway it repeats from the start, and the inner steps’ own timeout and retry settings do not apply.',
  durable:
    'Each item runs as its own checkpointed run, so every inner step retries and times out on its own terms and a failure resumes instead of repeating. Costs one run start per item, so it suits shorter lists over real pipelines.',
}

export function BranchInspector({
  node,
  graph,
  onChange,
  itemSchema,
}: NodeInspectorProps) {
  const { Input, Label } = useWfComponents()
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

// One leading marker per case — the key the author sees on the row, on the
// node's outgoing handle, and on the edge. Rendered as a badge rather than an
// editable field: the key is bookkeeping the graph needs, not a decision the
// author should have to make.
function CaseMarker({ children }: { children: ReactNode }) {
  return (
    <span className="border-input bg-muted text-muted-foreground min-w-9 shrink-0 rounded-md border px-2 py-1.5 text-center font-mono text-xs">
      {children}
    </span>
  )
}

// The Switch inspector. A Switch matches ONE upstream value against a list of
// cases, so the editor asks for exactly that: pick the value with the same data
// picker every other node uses, then per case type the value it must equal — or
// link a second upstream value to compare against. Each case's key is minted as
// a letter (A, B, C…) and never re-lettered, so it stays a stable edge label.
export function SwitchInspector({
  node,
  graph,
  onChange,
  itemSchema,
}: NodeInspectorProps) {
  const { Label } = useWfComponents()
  if (node.kind !== 'switch') return null

  const cases = node.config.cases
  const setCases = (next: typeof cases) =>
    onChange({ ...node, config: { ...node.config, cases: next } })
  const setCaseValue = (index: number, value: ArgBinding) =>
    setCases(cases.map((c, i) => (i === index ? { ...c, value } : c)))

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
            onChange({ ...node, config: { ...node.config, source } })
          }
        />
        <p className="text-muted-foreground text-xs">
          Connect the upstream value to match. Leave unset to match the whole
          incoming input.
        </p>
      </div>
      <div className={field}>
        <Label>Cases</Label>
        {cases.map((c, i) => (
          <div key={c.key} className="flex items-start gap-1.5">
            <CaseMarker>{c.key}</CaseMarker>
            <div className="min-w-0 flex-1">
              <DataRefField
                node={node}
                graph={graph}
                itemSchema={itemSchema}
                // A ref-valued case shows as a link; anything else is the
                // author's typed literal, editable in place.
                value={c.value.kind === 'ref' ? c.value : undefined}
                emptyLabel="equals…"
                literal={{
                  value: literalText(c.value),
                  placeholder: 'equals…',
                  onChange: (value) =>
                    setCaseValue(i, { kind: 'literal', value }),
                }}
                // Clearing the link drops back to an empty typed value, so the
                // row is never left without a binding.
                onChange={(ref) =>
                  setCaseValue(i, ref ?? { kind: 'literal', value: '' })
                }
              />
            </div>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground shrink-0 rounded px-1.5 py-1.5 text-xs"
              aria-label={`Remove case ${c.key}`}
              onClick={() => setCases(cases.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
        ))}
        <div className="flex items-start gap-1.5">
          <CaseMarker>{SWITCH_DEFAULT_CASE}</CaseMarker>
          <p className="text-muted-foreground flex-1 py-1.5 text-xs">
            No case matched.
          </p>
        </div>
        <button
          type="button"
          className="border-input hover:bg-accent self-start rounded-md border px-2 py-1 text-xs"
          onClick={() =>
            setCases([
              ...cases,
              {
                key: nextSwitchCaseKey(cases.map((c) => c.key)),
                value: { kind: 'literal', value: '' },
              },
            ])
          }
        >
          + Add case
        </button>
      </div>
      <p className="text-muted-foreground text-xs">
        Deterministic — no model call. Cases are matched in order, and each one
        grows its own outgoing edge; a value matching none takes the
        always-present <strong>else</strong> edge.
      </p>
    </>
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
          How many items run at once (1–20). 1 runs them one at a time.
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
        When off, a failed item is recorded and the rest keep running; the
        output collects a placeholder in that item's slot.
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
