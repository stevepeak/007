import { Link2, X } from 'lucide-react'
import { useState } from 'react'

import type {
  JsonSchema,
  RefBinding,
  WorkflowGraph,
  WorkflowNode,
} from '../../engine'
import { cn } from '../cn'
import { useAccessibleData } from './node-data-panel-shared'
import { BindingSourceNode } from './node-data-panel-picker'

export type DataRefFieldProps = {
  node: WorkflowNode
  graph: WorkflowGraph
  /** The current upstream ref, or undefined for "the whole incoming input". */
  value: RefBinding | undefined
  onChange: (ref: RefBinding | undefined) => void
  /** Element schema of the enclosing loop's list, if any (see NodeInputsPanel). */
  itemSchema?: JsonSchema
}

// A single "connect to upstream data" selector — the same accessible-data picker
// agent/tool inputs use (BindingSourceNode/PickableField), but producing a bare
// `ref` (no literal). Deterministic decision nodes (branch) use it to choose the
// upstream value they test instead of typing a dotted path.
export function DataRefField({
  node,
  graph,
  value,
  onChange,
  itemSchema,
}: DataRefFieldProps) {
  const { accessible } = useAccessibleData(node, graph, itemSchema)
  const [open, setOpen] = useState(false)
  const src = value
    ? accessible.find((n) => n.nodeId === value.nodeId)
    : undefined
  const label = value
    ? `${src?.label ?? value.nodeId} · ${value.path || 'whole output'}`
    : 'Whole input'

  return (
    <div className="rounded-md border border-input">
      <div className="flex items-center gap-2 px-2 py-1.5">
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
            aria-label="Clear source"
            onClick={() => onChange(undefined)}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-muted-foreground"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Connect to upstream data"
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
              No upstream data to test yet. Connect this node to a source.
            </p>
          ) : (
            <div className="space-y-1.5">
              {accessible.map((n) => (
                <BindingSourceNode
                  key={n.nodeId}
                  node={n}
                  onPick={(path) => {
                    onChange({ kind: 'ref', nodeId: n.nodeId, path })
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
