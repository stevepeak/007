import { ListOrdered, Link2, X } from 'lucide-react'
import { useState } from 'react'

import type {
  JsonSchema,
  RefBinding,
  WorkflowGraph,
  WorkflowNode,
} from '../../engine'
import { cn } from '../cn'
import { type AccessibleNode, type DataField } from './node-io'
import { useAccessibleData } from './node-data-panel-shared'

export type IterationListFieldProps = {
  node: WorkflowNode
  graph: WorkflowGraph
  /** The current list ref, or undefined when no list has been picked. */
  value: RefBinding | undefined
  /** Element schema of the enclosing loop's list, if this iteration is nested in
   * another (so upstream `Item` fields are pickable). */
  itemSchema?: JsonSchema
  /** Emits the chosen ref plus the inferred element schema (for the inner `Item`
   * node's fields), or (undefined, undefined) when cleared. */
  onSelect: (source: RefBinding | undefined, itemSchema?: JsonSchema) => void
}

// The iteration node's list selector — the SAME drill-down data picker agent/tool
// inputs and the branch source use, over every upstream node (not just direct
// predecessors), producing a `ref`. Nodes don't forward data, so an iteration
// names its list at the producing node directly (e.g. the tool upstream of a
// Branch it sits behind). Only ARRAY fields are selectable; other fields render
// for context. Picking also records the element schema for the inner `Item`.
export function IterationListField({
  node,
  graph,
  value,
  itemSchema,
  onSelect,
}: IterationListFieldProps) {
  const { accessible } = useAccessibleData(node, graph, itemSchema)
  const [open, setOpen] = useState(false)
  const src = value
    ? accessible.find((n) => n.nodeId === value.nodeId)
    : undefined
  const label = value
    ? `${src?.label ?? value.nodeId} · ${value.path || 'whole output'}`
    : 'Select a list…'

  return (
    <div className="rounded-md border border-input">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <ListOrdered className="size-3.5 shrink-0 text-muted-foreground" />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-xs',
            value ? 'text-muted-foreground' : 'text-muted-foreground',
          )}
        >
          {label}
        </span>
        {value ? (
          <button
            type="button"
            aria-label="Clear list"
            onClick={() => onSelect(undefined, undefined)}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-muted-foreground"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Pick a list to iterate"
          onClick={() => setOpen((o) => !o)}
          className={cn(
            'shrink-0 rounded p-0.5 hover:bg-accent',
            open
              ? 'text-foreground'
              : 'text-muted-foreground hover:text-muted-foreground',
          )}
        >
          <Link2 className="size-3.5" />
        </button>
      </div>

      {open ? (
        <div className="space-y-2 border-t border-neutral-100 p-2">
          {accessible.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              No upstream data yet. Connect this block to a node that outputs a
              list.
            </p>
          ) : (
            <div className="space-y-1.5">
              {accessible.map((n) => (
                <IterationSourceNode
                  key={n.nodeId}
                  node={n}
                  value={value}
                  onPick={(source, elemSchema) => {
                    onSelect(source, elemSchema)
                    setOpen(false)
                  }}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

// One upstream node in the iteration list picker. Its whole output is selectable
// only when it is itself an array; otherwise drill into its fields for an array.
function IterationSourceNode({
  node,
  value,
  onPick,
}: {
  node: AccessibleNode
  value: RefBinding | undefined
  onPick: (source: RefBinding, itemSchema?: JsonSchema) => void
}) {
  const wholeIsList = node.wholeType === 'array'
  const selectedWhole =
    value?.nodeId === node.nodeId && (value.path ?? '') === ''
  return (
    <div className="rounded border border-neutral-100 bg-muted/50">
      <button
        type="button"
        disabled={!wholeIsList}
        onClick={() => onPick({ kind: 'ref', nodeId: node.nodeId, path: '' })}
        className={cn(
          'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left',
          wholeIsList ? 'hover:bg-accent' : 'cursor-default',
          wholeIsList && selectedWhole && 'bg-violet-50',
        )}
      >
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {node.label}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {wholeIsList ? 'list' : node.wholeType}
        </span>
      </button>
      {node.fields.length > 0 ? (
        <div className="pb-1">
          {node.fields.map((f) => (
            <IterationField
              key={f.path}
              field={f}
              nodeId={node.nodeId}
              depth={1}
              value={value}
              onPick={onPick}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function IterationField({
  field,
  nodeId,
  depth,
  value,
  onPick,
}: {
  field: DataField
  nodeId: string
  depth: number
  value: RefBinding | undefined
  onPick: (source: RefBinding, itemSchema?: JsonSchema) => void
}) {
  const isList = field.type === 'array'
  const selected = value?.nodeId === nodeId && value.path === field.path
  return (
    <>
      <button
        type="button"
        disabled={!isList}
        onClick={() =>
          onPick({ kind: 'ref', nodeId, path: field.path }, field.itemSchema)
        }
        title={field.description}
        style={{ paddingLeft: depth * 12 + 6 }}
        className={cn(
          'flex w-full items-center gap-1.5 py-0.5 pr-1.5 text-left',
          isList ? 'hover:bg-accent' : 'cursor-default',
          isList && selected && 'bg-violet-50',
        )}
      >
        <span
          className={cn(
            'min-w-0 truncate text-xs',
            isList ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          {field.label}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {field.type}
        </span>
      </button>
      {/* Drill into nested objects to reach arrays deeper in the shape. */}
      {field.children?.map((c) => (
        <IterationField
          key={c.path}
          field={c}
          nodeId={nodeId}
          depth={depth + 1}
          value={value}
          onPick={onPick}
        />
      ))}
    </>
  )
}
