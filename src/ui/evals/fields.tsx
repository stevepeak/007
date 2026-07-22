import { ChevronDown } from 'lucide-react'
import { useRef, useState } from 'react'

import type { JsonSchema } from '../../engine'
import { evalMatchSchema, type EvalMatch } from '../../server/protocol'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import { useTools } from '../hooks'
import { ToolIcon } from '../tool-icon'
import { useCommittedField } from '../use-committed-field'
import { useDismiss } from '../use-dismiss'

const MATCH_OPTIONS = evalMatchSchema.options

/** Render a stored check value back into an editable string. */
function valueToStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === undefined) return ''
  return JSON.stringify(v)
}
/** Parse an entered value: JSON when it parses (numbers/booleans/objects), else raw string. */
function parseValue(s: string): unknown {
  const t = s.trim()
  if (t === '') return ''
  try {
    return JSON.parse(t)
  } catch {
    return s
  }
}

// ── Field primitives ─────────────────────────────────────────────────────────

// Tool selector — a dropdown of the host's tools (icon + name + short blurb),
// replacing the bare name-only <select>. Expands inline (in normal flow) so it
// can't be clipped by the StepFlow card's `overflow-hidden`. When `allowToolIds`
// is given (an agent target's wired tools), the list is scoped to just those —
// a tool the agent can't call would never fire, so it's never worth offering.
export function ToolPicker({
  value,
  onChange,
  allowToolIds,
}: {
  value: string
  onChange: (toolId: string) => void
  /** Restrict the options to these tool ids (undefined = all host tools). */
  allowToolIds?: string[]
}) {
  const { Label } = useWfComponents()
  const toolsQuery = useTools()
  const all = toolsQuery.data ?? []
  // Keep a stored-but-out-of-scope value visible so switching targets or a
  // hand-authored id never silently vanishes (the trigger shows "(not found)").
  const tools = allowToolIds
    ? all.filter((t) => allowToolIds.includes(t.id) || t.id === value)
    : all
  const selected = tools.find((t) => t.id === value)

  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useDismiss(rootRef, open, () => setOpen(false))

  return (
    <div className="space-y-1">
      <Label>Tool</Label>
      <div ref={rootRef} className="space-y-2">
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex h-9 w-full items-center gap-2 rounded-md border border-neutral-300 bg-transparent px-2 text-sm outline-none transition focus:border-neutral-500"
        >
          <ToolIcon icon={selected?.icon} className="size-5" />
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-left',
              selected ? 'text-neutral-800' : 'text-neutral-400',
            )}
          >
            {selected?.name ??
              (toolsQuery.isLoading ? 'Loading tools…' : 'Select a tool…')}
            {value && !selected && !toolsQuery.isLoading ? (
              <span className="ml-1 text-xs text-amber-600">(not found)</span>
            ) : null}
          </span>
          <ChevronDown
            className={cn(
              'size-4 shrink-0 text-neutral-400 transition',
              open && 'rotate-180',
            )}
          />
        </button>

        {open ? (
          <div className="max-h-72 overflow-y-auto rounded-md border border-neutral-200 py-1">
            {toolsQuery.isLoading ? (
              <div className="px-3 py-6 text-center text-sm text-neutral-400">
                Loading tools…
              </div>
            ) : tools.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-neutral-500">
                No tools available.
              </div>
            ) : (
              tools.map((t) => {
                const isSel = t.id === value
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="option"
                    aria-selected={isSel}
                    onClick={() => {
                      onChange(t.id)
                      setOpen(false)
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 px-2 py-1.5 text-left transition',
                      isSel ? 'bg-neutral-100' : 'hover:bg-neutral-50',
                    )}
                  >
                    <ToolIcon icon={t.icon} className="size-5" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-neutral-800">
                        {t.name}
                      </span>
                      {t.description ? (
                        <span className="block truncate text-xs text-neutral-400">
                          {t.description}
                        </span>
                      ) : null}
                    </span>
                  </button>
                )
              })
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function BoolPicker({
  label,
  value,
  trueLabel,
  falseLabel,
  onChange,
}: {
  label: string
  value: boolean
  trueLabel: string
  falseLabel: string
  onChange: (v: boolean) => void
}) {
  const { Label } = useWfComponents()
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <select
        value={value ? 'true' : 'false'}
        onChange={(e) => onChange(e.target.value === 'true')}
        className="h-9 w-full rounded-md border border-neutral-300 bg-transparent px-2 text-sm outline-none focus:border-neutral-500"
      >
        <option value="true">{trueLabel}</option>
        <option value="false">{falseLabel}</option>
      </select>
    </div>
  )
}

export function TextField({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string
  value: string
  placeholder?: string
  onCommit: (v: string) => void
}) {
  const { Input, Label } = useWfComponents()
  const field = useCommittedField(value, onCommit)
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Input
        value={field.value}
        placeholder={placeholder}
        onChange={(e) => field.onChange(e.target.value)}
        onBlur={field.onBlur}
        className="font-mono text-xs"
      />
    </div>
  )
}

/** A selectable field from a target's output schema — drives the path dropdown. */
type PathOption = {
  value: string
  label: string
  type?: string
  description?: string
}

// Top-level fields of an output JSON Schema, as path options (with descriptions).
// Null when there's no usable object schema — callers fall back to a free-form path.
export function outputPathOptions(
  schema: JsonSchema | null | undefined,
): PathOption[] | null {
  if (!schema || schema.type !== 'object') return null
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>
  const entries = Object.entries(props)
  if (entries.length === 0) return null
  return entries.map(([key, s]) => ({
    value: key,
    label: key,
    type: typeof s.type === 'string' ? s.type : undefined,
    description: typeof s.description === 'string' ? s.description : undefined,
  }))
}

// The match/path/value trio shared by the *_match check types. When `pathOptions`
// is supplied (an agent target with a known output schema), the path is chosen
// from a dropdown of the schema's fields — with each field's description shown —
// instead of a free-form text box.
export function MatchRow({
  path,
  match,
  value,
  pathLabel,
  pathPlaceholder,
  pathOptions,
  onChange,
}: {
  path: string | undefined
  match: EvalMatch
  value: unknown
  pathLabel: string
  pathPlaceholder?: string
  pathOptions?: PathOption[] | null
  onChange: (patch: {
    path?: string
    match?: EvalMatch
    value?: unknown
  }) => void
}) {
  const { Input, Label } = useWfComponents()
  const pathField = useCommittedField(path ?? '', (p) =>
    onChange({ path: p || undefined }),
  )
  const valueField = useCommittedField(valueToStr(value), (v) =>
    onChange({ value: parseValue(v) }),
  )

  const selectedField = pathOptions?.find((o) => o.value === (path ?? ''))
  // Preserve a stored path that isn't in the schema (nested/custom) as its own
  // option so switching targets or hand-authored paths never silently vanish.
  const showsCustom = Boolean(
    pathOptions && path && !pathOptions.some((o) => o.value === path),
  )

  return (
    <div className="space-y-1">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label>{pathLabel}</Label>
          {pathOptions ? (
            <select
              value={path ?? ''}
              onChange={(e) => onChange({ path: e.target.value || undefined })}
              className="h-9 w-full rounded-md border border-neutral-300 bg-transparent px-2 text-sm outline-none focus:border-neutral-500"
            >
              <option value="">Entire output</option>
              {pathOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                  {o.type ? ` · ${o.type}` : ''}
                </option>
              ))}
              {showsCustom ? (
                <option value={path}>{path} (custom)</option>
              ) : null}
            </select>
          ) : (
            <Input
              value={pathField.value}
              placeholder={pathPlaceholder}
              onChange={(e) => pathField.onChange(e.target.value)}
              onBlur={pathField.onBlur}
              className="font-mono text-xs"
            />
          )}
        </div>
        <div className="space-y-1">
          <Label>Match</Label>
          <select
            value={match}
            onChange={(e) => onChange({ match: e.target.value as EvalMatch })}
            className="h-9 w-full rounded-md border border-neutral-300 bg-transparent px-2 text-sm outline-none focus:border-neutral-500"
          >
            {MATCH_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label>Value</Label>
          <Input
            value={valueField.value}
            placeholder="expected"
            onChange={(e) => valueField.onChange(e.target.value)}
            onBlur={valueField.onBlur}
            className="font-mono text-xs"
          />
        </div>
      </div>
      {selectedField?.description ? (
        <p className="text-xs text-neutral-400">{selectedField.description}</p>
      ) : null}
    </div>
  )
}
