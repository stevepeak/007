import { ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'

import type {
  JsonSchema,
  WorkflowGraph,
  WorkflowNode,
} from '../../engine'
import { cn } from '../cn'
import {
  nodeProvides,
  type AccessibleNode,
  type DataField,
} from './node-io'
import { useAccessibleData } from './node-data-panel-shared'

export type AccessibleDataViewProps = {
  node: WorkflowNode
  graph: WorkflowGraph
  /** Element schema of the enclosing loop's list, if any (see NodeInputsPanel). */
  itemSchema?: JsonSchema
}

// The Data tab of the bottom dock. Two read-only sections: "Available" — the
// tree of everything upstream that the node can map from (produced by earlier
// nodes) — and "Provides" — the shape this node itself emits to nodes
// downstream. The actual mapping happens in the inspector's Inputs section.
export function AccessibleDataView({
  node,
  graph,
  itemSchema,
}: AccessibleDataViewProps) {
  const { accessible, maps } = useAccessibleData(node, graph, itemSchema)
  const provides = useMemo(
    () => nodeProvides(graph, node.id, maps),
    [graph, node.id, maps],
  )
  // `accessibleData` folds the iteration `Item` trigger's own output into the
  // accessible list (it's the data source inside a loop). Don't repeat it as its
  // own "Provides" row in that case.
  const showProvides =
    provides != null && !accessible.some((n) => n.nodeId === provides.nodeId)

  return (
    <div className="space-y-4">
      <section className="space-y-1.5">
        <div className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          Available
        </div>
        {accessible.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            No upstream nodes. Connect{' '}
            <span className="font-medium">{node.label}</span> to a source to
            receive data.
          </p>
        ) : (
          <div className="space-y-2">
            {accessible.map((n) => (
              <AccessibleNodeView key={n.nodeId} node={n} />
            ))}
          </div>
        )}
      </section>

      {showProvides ? (
        <section className="space-y-1.5">
          <div className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
            Provides
          </div>
          {provides.wholeType === 'none' ? (
            <p className="text-muted-foreground text-xs">
              This node produces no data.
            </p>
          ) : (
            <AccessibleNodeView node={provides} />
          )}
        </section>
      ) : null}
    </div>
  )
}

// Read-only rendering of one accessible node's output shape in the always-on
// "Accessible data" tree.
function AccessibleNodeView({ node }: { node: AccessibleNode }) {
  const [open, setOpen] = useState(true)
  const hasFields = node.fields.length > 0
  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        disabled={!hasFields}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
      >
        {hasFields ? (
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-90',
            )}
          />
        ) : (
          <span className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {node.label}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {node.wholeType}
        </span>
      </button>
      {hasFields && open ? (
        <div className="border-t border-neutral-100 pb-1">
          {node.fields.map((f) => (
            <FieldView key={f.path} field={f} depth={1} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function FieldView({ field, depth }: { field: DataField; depth: number }) {
  return (
    <>
      <div
        style={{ paddingLeft: depth * 12 + 8 }}
        className="flex items-center gap-1.5 py-0.5 pr-2"
        title={field.description}
      >
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {field.label}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {field.type}
        </span>
        {field.description ? (
          <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
            — {field.description}
          </span>
        ) : null}
      </div>
      {field.children?.map((c) => (
        <FieldView key={c.path} field={c} depth={depth + 1} />
      ))}
      {/* Array element shape — read-only; each item's fields nest one level in. */}
      {field.items?.map((c) => (
        <FieldView key={c.path} field={c} depth={depth + 1} />
      ))}
    </>
  )
}
