import { type AccessibleNode, type DataField } from './node-io'

// One upstream node inside the binding picker: pick its whole output or drill
// into a specific field.
export function BindingSourceNode({
  node,
  onPick,
}: {
  node: AccessibleNode
  onPick: (path: string) => void
}) {
  return (
    <div className="rounded border border-neutral-100 bg-muted/50">
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
      {node.fields.length > 0 ? (
        <div className="pb-1">
          {node.fields.map((f) => (
            <PickableField key={f.path} field={f} depth={1} onPick={onPick} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function PickableField({
  field,
  depth,
  onPick,
}: {
  field: DataField
  depth: number
  onPick: (path: string) => void
}) {
  return (
    <>
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
      {field.children?.map((c) => (
        <PickableField
          key={c.path}
          field={c}
          depth={depth + 1}
          onPick={onPick}
        />
      ))}
    </>
  )
}
