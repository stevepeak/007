import { BRANCH_OPERATORS } from '../../engine'
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
