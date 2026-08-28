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
  /** What an unbound field reads as. Defaults to "the whole incoming input",
   * which is what a Branch/Output source means — a Switch case means nothing of
   * the sort, so it names its own empty state. */
  emptyLabel?: string
  /**
   * Turns the field into "type a value OR link one": while no ref is bound the
   * label is replaced by this text input, in the SAME box, so the author sees
   * one control with two ways to fill it rather than two stacked controls.
   */
  literal?: {
    value: string
    onChange: (value: string) => void
    placeholder?: string
    /**
     * The allowed values, when the thing being matched declares an enum. The
     * free-text box becomes a picker of exactly those, so an author can't miss
     * by a letter on a value the schema already spells out. A stored value that
     * isn't among them is kept as an extra option rather than silently dropped.
     */
    options?: unknown[]
  }
  /** Marks the field as the thing an issue is complaining about — an unfilled
   * Switch case reads as "type a value here", not as a message somewhere else
   * about a letter the author never chose. */
  invalid?: boolean
}

// A single "connect to upstream data" selector — the same accessible-data picker
// agent/tool inputs use (BindingSourceNode/PickableField), but producing a bare
// `ref` (no literal). Deterministic decision nodes (branch) use it to choose the
// upstream value they test instead of typing a dotted path.
//
// The row carries exactly ONE trailing control at any time — the link icon while
// nothing is bound, the clear ✕ once something is — because this field also has
// to fit a Switch case row beside a name box and a remove button, where two
// icons plus a truncated label left nothing readable. When a ref IS bound the
// chip itself is the button that reopens the picker, so re-pointing a link costs
// the same one click it always did.
export function DataRefField({
  node,
  graph,
  value,
  onChange,
  itemSchema,
  emptyLabel,
  literal,
  invalid,
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
  const options = literal?.options

  return (
    <div ref={boxRef} className="relative">
      <div
        className={cn(
          'flex items-center gap-1 rounded-md border border-input py-0.5 pr-0.5 pl-1.5',
          open && 'border-ring',
          invalid && 'border-destructive',
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
            <span className="text-muted-foreground max-w-[45%] truncate text-[11px]">
              {sourceLabel}
            </span>
            <span className="text-foreground min-w-0 flex-1 truncate text-[11px]">
              {fieldLabel}
            </span>
          </button>
        ) : options ? (
          <select
            className="text-foreground min-w-0 flex-1 bg-transparent py-1 text-[11px] outline-none"
            value={literal.value}
            onChange={(e) => literal.onChange(e.target.value)}
          >
            <option value="">{literal.placeholder ?? 'Select a value…'}</option>
            {(options.some((o) => String(o) === literal.value) ||
            literal.value === ''
              ? options
              : [...options, literal.value]
            ).map((o) => (
              <option key={String(o)} value={String(o)}>
                {String(o)}
              </option>
            ))}
          </select>
        ) : literal ? (
          <input
            className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent py-1 text-[11px] outline-none"
            value={literal.value}
            placeholder={literal.placeholder ?? emptyLabel}
            onChange={(e) => literal.onChange(e.target.value)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="text-muted-foreground min-w-0 flex-1 truncate py-1 text-left text-[11px]"
          >
            {emptyLabel ?? 'Whole input'}
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
        // Anchored to the field's right edge and free to be wider than it: a
        // Switch case row is a third of the panel, and a source tree squeezed
        // into that column can't be read at all.
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
