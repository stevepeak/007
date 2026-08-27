import {
  acceptsValueType,
  type AccessibleNode,
  type DataField,
} from './node-io'

// One row of the binding picker: a field, whether it may itself be picked, and
// its surviving children. A field whose type the input can't accept still shows
// as an unpickable HEADER when something inside it fits — otherwise `data.count`
// would be unreachable just because `data` is an object and the input wants a
// number.
export type PickRow = {
  field: DataField
  pickable: boolean
  children: PickRow[]
}

/** An upstream node, pruned to what a given input can actually take. */
export type PickableSource = {
  node: AccessibleNode
  /** Whether the node's WHOLE output is an acceptable value on its own. */
  wholePickable: boolean
  rows: PickRow[]
}

function prune(
  fields: DataField[],
  accepts: (type: string) => boolean,
): PickRow[] {
  const rows: PickRow[] = []
  for (const field of fields) {
    const children = prune(field.children ?? [], accepts)
    const pickable = accepts(field.type)
    if (pickable || children.length > 0)
      rows.push({ field, pickable, children })
  }
  return rows
}

/**
 * The upstream nodes worth offering for one input, each pruned to the fields
 * whose type it accepts. Nodes left with nothing pickable drop out entirely, so
 * an author mapping a `boolean` sees only the booleans (plus whatever is opaque
 * enough to still qualify — see `acceptsValueType`).
 *
 * `inputType` undefined means "takes anything", which is the whole picker
 * unfiltered — what `DataRefField` wants, since a Branch tests any value.
 */
export function pickableSources(
  accessible: AccessibleNode[],
  inputType?: string,
): PickableSource[] {
  const accepts = (type: string) => acceptsValueType(inputType, type)
  const sources: PickableSource[] = []
  for (const node of accessible) {
    const rows = prune(node.fields, accepts)
    const wholePickable = accepts(node.wholeType)
    if (wholePickable || rows.length > 0) {
      sources.push({ node, wholePickable, rows })
    }
  }
  return sources
}

// One upstream node inside the binding picker: pick its whole output or drill
// into a specific field.
export function BindingSourceNode({
  source,
  onPick,
}: {
  source: PickableSource
  onPick: (path: string) => void
}) {
  const { node, wholePickable, rows } = source
  return (
    <div className="rounded border border-neutral-100 bg-muted/50">
      {wholePickable ? (
        <button
          type="button"
          onClick={() => onPick('')}
          className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-accent"
        >
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
            {node.label}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {node.wholeType}
          </span>
        </button>
      ) : (
        // The node's own output is the wrong shape, but something inside it
        // fits — so it stays as a heading over its usable fields.
        <div className="flex w-full items-center gap-1.5 px-1.5 py-1">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
            {node.label}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground/60">
            {node.wholeType}
          </span>
        </div>
      )}
      {rows.length > 0 ? (
        <div className="pb-1">
          {rows.map((row) => (
            <PickableField
              key={row.field.path}
              row={row}
              depth={1}
              onPick={onPick}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function PickableField({
  row,
  depth,
  onPick,
}: {
  row: PickRow
  depth: number
  onPick: (path: string) => void
}) {
  const { field, pickable, children } = row
  return (
    <>
      {pickable ? (
        <button
          type="button"
          onClick={() => onPick(field.path)}
          title={field.description}
          style={{ paddingLeft: depth * 12 + 6 }}
          className="flex w-full items-center gap-1.5 py-0.5 pr-1.5 text-left hover:bg-accent"
        >
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {field.label}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {field.type}
          </span>
        </button>
      ) : (
        <div
          title={field.description}
          style={{ paddingLeft: depth * 12 + 6 }}
          className="flex w-full items-center gap-1.5 py-0.5 pr-1.5"
        >
          <span className="min-w-0 truncate text-xs text-muted-foreground/60">
            {field.label}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground/60">
            {field.type}
          </span>
        </div>
      )}
      {children.map((c) => (
        <PickableField
          key={c.field.path}
          row={c}
          depth={depth + 1}
          onPick={onPick}
        />
      ))}
    </>
  )
}
