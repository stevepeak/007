import { ChevronRight, ListOrdered, Link2, Pencil, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import type {
  ArgBinding,
  JsonSchema,
  RefBinding,
  WorkflowGraph,
  WorkflowNode,
} from '../../engine'
import { useWfComponents } from '../context'
import { useAgents, useTools, useTriggerEvents } from '../hooks'
import { cn } from '../cn'
import {
  accessibleData,
  buildIoMaps,
  nodeProvides,
  nodeRequires,
  withIterationItemSchema,
  type AccessibleNode,
  type DataField,
} from './node-io'

// The data-mapping surface for the inspector: the node's required inputs (each
// bindable to an upstream node's output or a literal) and a read-only tree of
// all data accessible to the node based on the graph.

// Only agent (prompt variables → `inputs`) and tool (arguments → `args`) nodes
// carry per-input bindings today.
function bindingsOf(node: WorkflowNode): Record<string, ArgBinding> {
  if (node.kind === 'agent') return node.config.inputs ?? {}
  if (node.kind === 'tool') return node.config.args ?? {}
  return {}
}

function withBinding(
  node: WorkflowNode,
  key: string,
  binding: ArgBinding | null,
): WorkflowNode {
  const next = { ...bindingsOf(node) }
  if (binding == null) delete next[key]
  else next[key] = binding
  if (node.kind === 'agent')
    return { ...node, config: { ...node.config, inputs: next } }
  if (node.kind === 'tool')
    return { ...node, config: { ...node.config, args: next } }
  return node
}

// Shared hook: resolve the tool/agent/trigger metadata maps once from the data
// client (react-query caches, so calling it in more than one panel is cheap).
export function useIoMaps() {
  const tools = useTools()
  const agents = useAgents()
  const triggerEvents = useTriggerEvents()
  return useMemo(
    () =>
      buildIoMaps(
        tools.data ?? [],
        agents.data ?? [],
        triggerEvents.data ?? [],
      ),
    [tools.data, agents.data, triggerEvents.data],
  )
}

// Shared hook: resolve the metadata maps (folding in the enclosing loop's `Item`
// schema) and, from them, the tree of upstream data a node can map from. Every
// data-mapping panel needs this same trio; some also read `maps` directly (e.g.
// to derive the node's own required inputs or provided output shape).
function useAccessibleData(
  node: WorkflowNode,
  graph: WorkflowGraph,
  itemSchema?: JsonSchema,
) {
  const baseMaps = useIoMaps()
  const maps = useMemo(
    () => withIterationItemSchema(baseMaps, itemSchema),
    [baseMaps, itemSchema],
  )
  const accessible = useMemo(
    () => accessibleData(graph, node.id, maps),
    [graph, node.id, maps],
  )
  return { accessible, maps }
}

export type NodeInputsPanelProps = {
  node: WorkflowNode
  graph: WorkflowGraph
  onChange: (next: WorkflowNode) => void
  /** Element schema of the enclosing loop's list, if this node is inside an
   * iteration — makes the `Item`'s fields bindable. */
  itemSchema?: JsonSchema
}

// The node's required inputs, each bindable to upstream data or a literal.
// Lives in the inspector (right rail); the accessible-data tree it binds from
// lives in the bottom dock (`AccessibleDataView`).
export function NodeInputsPanel({
  node,
  graph,
  onChange,
  itemSchema,
}: NodeInputsPanelProps) {
  const { accessible, maps } = useAccessibleData(node, graph, itemSchema)
  const requires = useMemo(() => nodeRequires(node, maps), [node, maps])
  const bindings = bindingsOf(node)
  if (node.kind !== 'agent' && node.kind !== 'tool') return null

  return (
    <section className="space-y-1.5">
      <div className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        Inputs
      </div>
      {requires.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          {node.kind === 'agent'
            ? 'This agent needs no variables.'
            : 'This tool takes no arguments.'}
        </p>
      ) : (
        <div className="space-y-1.5">
          {requires.map((input) => (
            <BindingField
              key={input.key}
              label={input.label}
              required={input.required}
              description={input.description}
              type={input.type}
              enumValues={input.enum}
              binding={bindings[input.key] ?? null}
              accessible={accessible}
              onSet={(b) => onChange(withBinding(node, input.key, b))}
            />
          ))}
        </div>
      )}
    </section>
  )
}

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

// The literal is typed into a single text box, but a tool arg / prompt variable
// can declare a non-string JSON type. Coerce the string to that declared type so
// a numeric input (e.g. `keepCount`) is stored as `0` (number), not `"0"` —
// otherwise the tool's Zod schema rejects it at run time. Unparseable input falls
// back to the raw string, so the schema still surfaces a clear validation error.
function coerceLiteral(raw: string, type?: string): unknown {
  switch (type) {
    case 'number':
    case 'integer': {
      const n = Number(raw)
      return raw.trim() !== '' && !Number.isNaN(n) ? n : raw
    }
    case 'boolean': {
      if (raw === 'true') return true
      if (raw === 'false') return false
      return raw
    }
    case 'object':
    case 'array': {
      try {
        return JSON.parse(raw)
      } catch {
        return raw
      }
    }
    default:
      return raw
  }
}

// Describes one binding: unmapped, a literal, or a ref into an upstream node.
function describeBinding(
  binding: ArgBinding | null,
  accessible: AccessibleNode[],
): string {
  if (!binding) return 'Not mapped'
  if (binding.kind === 'literal') {
    const v = binding.value
    return `Literal: ${typeof v === 'string' ? v : JSON.stringify(v)}`
  }
  const src = accessible.find((n) => n.nodeId === binding.nodeId)
  const label = src?.label ?? binding.nodeId
  return binding.path ? `${label} · ${binding.path}` : `${label} · whole output`
}

function BindingField({
  label,
  required,
  description,
  type,
  enumValues,
  binding,
  accessible,
  onSet,
}: {
  label: string
  required: boolean
  description?: string
  /** JSON Schema type of the input, used to coerce a typed literal. */
  type?: string
  /** Allowed values when the input is an enum — the literal editor becomes a
   * picker so a free-text value can't be entered. */
  enumValues?: unknown[]
  binding: ArgBinding | null
  accessible: AccessibleNode[]
  onSet: (binding: ArgBinding | null) => void
}) {
  const { Input, Select } = useWfComponents()
  const [open, setOpen] = useState(false)
  const [literal, setLiteral] = useState(
    binding?.kind === 'literal' ? String(binding.value ?? '') : '',
  )
  const mapped = Boolean(binding)

  return (
    <div className="rounded-md border border-input">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <code className="shrink-0 rounded bg-muted px-1 py-0.5 text-xs font-medium text-foreground">
          {label}
        </code>
        {required ? <span className="text-xs text-rose-500">*</span> : null}
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-xs',
            mapped ? 'text-muted-foreground' : 'text-muted-foreground',
          )}
          title={description}
        >
          {describeBinding(binding, accessible)}
        </span>
        {mapped ? (
          <button
            type="button"
            aria-label="Clear mapping"
            onClick={() => {
              onSet(null)
              setLiteral('')
            }}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-muted-foreground"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Map input"
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
              No upstream data to map from yet.
            </p>
          ) : (
            <div className="space-y-1.5">
              {accessible.map((n) => (
                <BindingSourceNode
                  key={n.nodeId}
                  node={n}
                  onPick={(path) => {
                    onSet({ kind: 'ref', nodeId: n.nodeId, path })
                    setOpen(false)
                  }}
                />
              ))}
            </div>
          )}
          {enumValues && enumValues.length > 0 ? (
            // Enum input: pick from the allowed values — no free-text, so an
            // invalid literal can't be entered. Selecting sets it immediately.
            <div className="flex items-center gap-1.5 border-t border-neutral-100 pt-2">
              <Pencil className="size-3 shrink-0 text-muted-foreground" />
              <Select
                value={
                  binding?.kind === 'literal' ? String(binding.value ?? '') : ''
                }
                onChange={(e) => {
                  const picked = enumValues.find(
                    (v) => String(v) === e.target.value,
                  )
                  if (picked === undefined) return
                  onSet({ kind: 'literal', value: picked })
                  setOpen(false)
                }}
                className="h-7 flex-1 rounded border border-input bg-card px-1.5 text-xs text-foreground"
              >
                <option value="" disabled>
                  Select a value…
                </option>
                {enumValues.map((v) => (
                  <option key={String(v)} value={String(v)}>
                    {String(v)}
                  </option>
                ))}
              </Select>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 border-t border-neutral-100 pt-2">
              <Pencil className="size-3 shrink-0 text-muted-foreground" />
              <Input
                value={literal}
                placeholder="or type a literal value…"
                onChange={(e) => setLiteral(e.target.value)}
                className="h-7 flex-1 text-xs"
              />
              <button
                type="button"
                disabled={literal.length === 0}
                onClick={() => {
                  onSet({
                    kind: 'literal',
                    value: coerceLiteral(literal, type),
                  })
                  setOpen(false)
                }}
                className="shrink-0 rounded border border-border px-2 py-1 text-xs text-muted-foreground transition hover:bg-accent disabled:opacity-40"
              >
                Set
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

// One upstream node inside the binding picker: pick its whole output or drill
// into a specific field.
function BindingSourceNode({
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
