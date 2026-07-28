import { useState } from 'react'

import { BRANCH_OPERATORS, type ArgBinding } from '../../engine'
import { useWfComponents } from '../context'
import { DataRefField, IterationListField } from './node-data-panel'
import { field, type NodeInspectorProps } from './node-inspector-shared'

export function BranchInspector({
  node,
  graph,
  onChange,
  itemSchema,
}: NodeInspectorProps) {
  const { Input, Label, Select } = useWfComponents()
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
        <Select
          value={node.config.operator}
          onChange={(e) =>
            onChange({
              ...node,
              config: {
                ...node.config,
                operator: e.target
                  .value as (typeof BRANCH_OPERATORS)[number],
              },
            })
          }
        >
          {BRANCH_OPERATORS.map((op) => (
            <option key={op} value={op}>
              {op.replace(/_/g, ' ')}
            </option>
          ))}
        </Select>
      </div>
      {node.config.operator !== 'is_empty' &&
      node.config.operator !== 'is_not_empty' ? (
        <div className={field}>
          <Label>Value</Label>
          <Input
            value={
              node.config.value == null ? '' : String(node.config.value)
            }
            onChange={(e) =>
              onChange({
                ...node,
                config: { ...node.config, value: e.target.value },
              })
            }
          />
        </div>
      ) : null}
      <p className="text-muted-foreground text-xs">
        Deterministic — no model call. The <strong>yes</strong> edge is
        taken when the condition holds.
      </p>
    </>
  )
}

export function SwitchInspector({ node, onChange }: NodeInspectorProps) {
  const { Input, Label } = useWfComponents()
  if (node.kind !== 'switch') return null
  return (
    <>
      <div className={field}>
        <Label>Input path</Label>
        <Input
          value={node.config.path}
          placeholder="e.g. source  ·  empty = whole input"
          onChange={(e) =>
            onChange({
              ...node,
              config: { ...node.config, path: e.target.value },
            })
          }
        />
        <p className="text-muted-foreground text-xs">
          The value at this path is matched against each case in order.
        </p>
      </div>
      <div className={field}>
        <Label>Cases</Label>
        {node.config.cases.map((c, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Input
              value={c.key}
              placeholder="key (edge label)"
              onChange={(e) => {
                const cases = node.config.cases.map((x, j) =>
                  j === i ? { ...x, key: e.target.value } : x,
                )
                onChange({ ...node, config: { ...node.config, cases } })
              }}
            />
            <Input
              value={c.value == null ? '' : String(c.value)}
              placeholder="equals value"
              onChange={(e) => {
                const cases = node.config.cases.map((x, j) =>
                  j === i ? { ...x, value: e.target.value } : x,
                )
                onChange({ ...node, config: { ...node.config, cases } })
              }}
            />
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground shrink-0 rounded px-1.5 py-1 text-xs"
              aria-label="Remove case"
              onClick={() => {
                const cases = node.config.cases.filter((_, j) => j !== i)
                onChange({ ...node, config: { ...node.config, cases } })
              }}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className="border-input hover:bg-accent self-start rounded-md border px-2 py-1 text-xs"
          onClick={() =>
            onChange({
              ...node,
              config: {
                ...node.config,
                cases: [...node.config.cases, { key: '', value: '' }],
              },
            })
          }
        >
          + Add case
        </button>
      </div>
      <p className="text-muted-foreground text-xs">
        Deterministic — no model call. Each case grows an outgoing edge; a
        value matching none takes the always-present <strong>default</strong>{' '}
        edge.
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
  const { Input, Label, Checkbox } = useWfComponents()
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
    entries.forEach(([k, v], i) => {
      next[i === index ? nextKey : k] = v
    })
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
          <DataRefField
            node={node}
            graph={graph}
            value={value?.kind === 'ref' ? value : undefined}
            itemSchema={itemSchema}
            onChange={(ref) =>
              onChange({ ...node, config: { value: ref } })
            }
          />
          {value?.kind !== 'ref' ? (
            <Input
              value={value?.kind === 'literal' ? String(value.value ?? '') : ''}
              placeholder="or a literal value…"
              onChange={(e) =>
                onChange({
                  ...node,
                  config: { value: { kind: 'literal', value: e.target.value } },
                })
              }
            />
          ) : null}
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
              <DataRefField
                node={node}
                graph={graph}
                value={binding.kind === 'ref' ? binding : undefined}
                itemSchema={itemSchema}
                onChange={(ref) =>
                  setFieldBinding(key, ref ?? { kind: 'literal', value: '' })
                }
              />
              {binding.kind === 'literal' ? (
                <Input
                  value={String(binding.value ?? '')}
                  placeholder="or a literal value…"
                  onChange={(e) =>
                    setFieldBinding(key, {
                      kind: 'literal',
                      value: e.target.value,
                    })
                  }
                />
              ) : null}
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
