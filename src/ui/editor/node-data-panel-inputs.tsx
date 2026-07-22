import { Link2, Pencil, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import type {
  ArgBinding,
  JsonSchema,
  WorkflowGraph,
  WorkflowNode,
} from '../../engine'
import { useWfComponents } from '../context'
import { cn } from '../cn'
import { nodeRequires, type AccessibleNode } from './node-io'
import { bindingsOf, useAccessibleData, withBinding } from './node-data-panel-shared'
import { BindingSourceNode } from './node-data-panel-picker'

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
