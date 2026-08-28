import { Link2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  JsonSchema,
  RefBinding,
  WorkflowGraph,
  WorkflowNode,
} from '../../engine'
import { cn } from '../cn'

import { BindingSourceNode, pickableSources } from './node-data-panel-picker'
import { useAccessibleData } from './node-data-panel-shared'

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
// `ref` (no literal). Deterministic decision nodes (Branch, Switch) and Output
// use it to choose the upstream value they read, instead of typing a dotted path.
//
// The row carries exactly ONE trailing control at any time — the link icon while
// nothing is bound, the clear ✕ once something is. Two icons plus a truncated
// path left nothing legible in a panel this narrow, and the pair read as one
// ambiguous cluster. When a ref IS bound the chip itself is the button that
// reopens the picker, so re-pointing a link still costs one click.
export function DataRefField({
  node,
  graph,
  value,
  onChange,
  itemSchema,
}: DataRefFieldProps) {
  const { accessible } = useAccessibleData(node, graph, itemSchema)
  // No declared target type here — a Branch tests whatever it is handed — so the
  // picker is offered whole, unfiltered.
  const sources = useMemo(() => pickableSources(accessible), [accessible])
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)
  // The picker overhangs the field, so it has to close on an outside click —
  // otherwise it sits over the row beneath it with no obvious way out.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const src = value
    ? accessible.find((n) => n.nodeId === value.nodeId)
    : undefined
  const sourceLabel = value ? (src?.label ?? value.nodeId) : ''
  const fieldLabel = value ? value.path || 'whole output' : ''

  return (
    <div ref={boxRef} className="relative">
      <div
        className={cn(
          'flex items-center gap-1 rounded-md border border-input py-0.5 pr-0.5 pl-1.5',
          open && 'border-ring',
        )}
      >
        {value ? (
          // Bound: the link chip IS the re-pick button. The node name gives the
          // field its context but yields width first — the path is the part that
          // says WHICH value this is, so it keeps the room.
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            title={`${sourceLabel} · ${fieldLabel}`}
            className="flex min-w-0 flex-1 items-center gap-1 py-1 text-left"
          >
            <Link2 className="text-muted-foreground size-3 shrink-0" />
            <span className="text-muted-foreground max-w-[45%] truncate text-xs">
              {sourceLabel}
            </span>
            <span className="text-foreground min-w-0 flex-1 truncate text-xs">
              {fieldLabel}
            </span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="text-muted-foreground min-w-0 flex-1 truncate py-1 text-left text-xs"
          >
            Whole input
          </button>
        )}
        <button
          type="button"
          aria-label={value ? 'Clear source' : 'Connect to upstream data'}
          onClick={() => (value ? onChange(undefined) : setOpen((o) => !o))}
          className={cn(
            'hover:bg-accent shrink-0 rounded p-1',
            open ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          {value ? <X className="size-3" /> : <Link2 className="size-3" />}
        </button>
      </div>

      {open ? (
        // Anchored to the field's right edge and free to be wider than it — a
        // source tree squeezed into the field's own width can't be read.
        <div className="border-input bg-card absolute top-full right-0 z-30 mt-1 max-h-72 w-60 min-w-full space-y-2 overflow-y-auto rounded-md border p-2 shadow-lg">
          {accessible.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              No upstream data to test yet. Connect this node to a source.
            </p>
          ) : (
            <div className="space-y-1.5">
              {sources.map((s) => (
                <BindingSourceNode
                  key={s.node.nodeId}
                  source={s}
                  onPick={(path) => {
                    onChange({ kind: 'ref', nodeId: s.node.nodeId, path })
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
