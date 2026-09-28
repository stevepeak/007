import { ChevronDown } from 'lucide-react'

import type { JsonSchema } from '../../engine'
import { evalMatchSchema, type EvalMatch } from '../../server/protocol'
import { cn } from '../cn'
import { useWfComponents } from '../context'
import { unwrapNullable } from '../editor/node-io'
import { useTools } from '../hooks'
import { Popover } from '../popover'
import { QueryState } from '../query-state'
import { toText } from '../to-text'
import { toolChip } from '../tool-appearance'
import { ToolIcon } from '../tool-icon'
import { useCommittedField } from '../use-committed-field'

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
export function EvalToolPicker({
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

  return (
    <div className="space-y-1">
      <Label>Tool</Label>
      {/* Inline (non-absolute) panel so it can't be clipped by the StepFlow
          card's `overflow-hidden`. */}
      <Popover
        className="space-y-2"
        panelClassName="max-h-72 overflow-y-auto rounded-md border border-neutral-200 py-1"
        trigger={({ open, toggle }) => (
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={open}
            onClick={toggle}
            className="flex h-9 w-full items-center gap-2 rounded-md border border-neutral-300 bg-transparent px-2 text-sm outline-none transition focus:border-neutral-500"
          >
            <span
              className={cn(
                'flex size-5 shrink-0 items-center justify-center overflow-hidden rounded',
                toolChip(selected?.color ?? null),
              )}
            >
              <ToolIcon
                icon={selected?.icon}
                iconName={selected?.iconName}
                iconUrl={selected?.iconUrl}
                className="size-3.5"
              />
            </span>
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
        )}
      >
        {({ close }) => (
          <QueryState
            query={{
              isLoading: toolsQuery.isLoading,
              error: null,
              data: tools,
            }}
            loading={
              <div className="px-3 py-6 text-center text-sm text-neutral-400">
                Loading tools…
              </div>
            }
            isEmpty={(tools) => tools?.length === 0}
            empty={
              <div className="px-3 py-6 text-center text-sm text-neutral-500">
                No tools available.
              </div>
            }
          >
            {(tools) => {
              return tools.map((t) => {
                const isSel = t.id === value
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="option"
                    aria-selected={isSel}
                    onClick={() => {
                      onChange(t.id)
                      close()
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 px-2 py-1.5 text-left transition',
                      isSel ? 'bg-neutral-100' : 'hover:bg-neutral-50',
                    )}
                  >
                    <span
                      className={cn(
                        'flex size-5 shrink-0 items-center justify-center overflow-hidden rounded',
                        toolChip(t.color),
                      )}
                    >
                      <ToolIcon
                        icon={t.icon}
                        iconName={t.iconName}
                        iconUrl={t.iconUrl}
                        className="size-3.5"
                      />
                    </span>
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
            }}
          </QueryState>
        )}
      </Popover>
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

/** A selectable field from a target's schema — drives the path dropdown. */
type PathOption = {
  value: string
  label: string
  type?: string
  description?: string
  /**
   * The closed set of values this field may hold (or, for a list, the values it
   * may hold ONE of), when its schema declares one. The expected-value box
   * becomes a picker of these instead of a free-text box the author has to spell
   * right — see {@link fieldValueOptions}.
   */
  values?: unknown[]
  /** The comparison those values are asserted with — see {@link fieldValueOptions}. */
  valueMatch?: EvalMatch
}

/**
 * The values a field is allowed to take, when its schema says so, and the
 * comparison that asserts one of them.
 *
 * Three shapes declare a closed set:
 *  • an enum — its members, compared with `equals`.
 *  • a boolean — a boolean IS an enum of two, `equals`.
 *  • a list of either — its ELEMENT's values, compared with `contains`, which is
 *    array membership. `equals` there would compare a whole list to one member
 *    and never hold.
 *
 * These are exactly the values that have to be typed right, which is why a text
 * box is the wrong control for them: `"true"` (the string an author types) never
 * equals `true` (what the run produced), `contains` against a boolean can't hold
 * at all, and a misremembered `UNCERTAIN`/`UNCLEAR` fails as a wrong answer
 * rather than as a typo.
 *
 * Undefined for everything else — an open-ended string or number has no list to
 * offer, so the caller keeps its text box.
 */
function fieldValueOptions(
  schema: JsonSchema,
): { values: unknown[]; match: EvalMatch } | undefined {
  const s = unwrapNullable(schema) ?? schema
  if (s.type === 'array') {
    const items = s.items
    if (!items || typeof items !== 'object' || Array.isArray(items)) return
    const element = fieldValueOptions(items as JsonSchema)
    // Only a scalar element's own set carries over; a list of lists has no
    // single value to pick.
    return element?.match === 'equals'
      ? { values: element.values, match: 'contains' }
      : undefined
  }
  if (s.type === 'boolean') return { values: [true, false], match: 'equals' }
  if (Array.isArray(s.enum) && s.enum.length > 0)
    return { values: s.enum, match: 'equals' }
  return undefined
}

// How far into a nested object the path picker descends. A check addresses a
// value with a dotted path, so a nested field is as assertable as a top-level
// one — but a deep schema flattens into a list nobody can read, and past a few
// levels the honest answer is to type the path.
const MAX_PATH_DEPTH = 3

// The fields of a JSON Schema, as path options (with descriptions and, where the
// schema declares one, the field's allowed values). Nested objects are flattened
// into their dotted paths — `equals` on the object itself, and one option per
// field inside it — because that is exactly what the graded path walk accepts.
//
// Arrays stop the descent: an element is addressed by an index nobody knows at
// author time, so a list is offered as one option and asserted with `contains`.
//
// Null when there's no usable object schema — callers fall back to a free-form
// path.
//
// Both sides of a `*_match` check derive from this: an agent target's output
// contract for `output_match`, and a tool's (Zod-derived) input schema for
// `tool_args_match`.
export function schemaPathOptions(
  schema: JsonSchema | null | undefined,
): PathOption[] | null {
  if (!schema || schema.type !== 'object') return null
  const options = pathOptionsOf(schema, '', 0)
  return options.length > 0 ? options : null
}

function pathOptionsOf(
  schema: JsonSchema,
  prefix: string,
  depth: number,
): PathOption[] {
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>
  return Object.entries(props).flatMap(([key, raw]) => {
    const s = unwrapNullable(raw) ?? raw
    const path = prefix ? `${prefix}.${key}` : key
    const declared = fieldValueOptions(raw)
    const self: PathOption = {
      value: path,
      label: path,
      type: typeof s.type === 'string' ? s.type : undefined,
      description: typeof s.description === 'string' ? s.description : undefined,
      values: declared?.values,
      valueMatch: declared?.match,
    }
    const nested =
      s.type === 'object' && depth + 1 < MAX_PATH_DEPTH
        ? pathOptionsOf(s, path, depth + 1)
        : []
    return [self, ...nested]
  })
}

// The match/path/value trio shared by the *_match check types. When `pathOptions`
// is supplied (a known output contract, or a tool's input schema), the path is
// chosen from a dropdown of the schema's fields — with each field's description
// shown — instead of a free-form text box.
//
// And when the chosen field declares its own values (an enum, or a boolean), the
// EXPECTED value is chosen from those too: the schema already knows the answer
// is one of `CLEAR | FLAG | UNCERTAIN | ERROR`, so asking the author to type one
// is asking them to get the spelling and the casing right for no reason. Picking
// from the list also keeps the value's TYPE — `true` stays a boolean instead of
// becoming the string `"true"`, which equals nothing the run will ever produce.
export function MatchRow({
  path,
  match,
  value,
  pathLabel,
  pathPlaceholder,
  pathOptions,
  wholeLabel = 'Entire output',
  pathPending,
  onChange,
}: {
  path: string | undefined
  match: EvalMatch
  value: unknown
  pathLabel: string
  pathPlaceholder?: string
  pathOptions?: PathOption[] | null
  /** What the empty path means, as the first option ("Entire output"). */
  wholeLabel?: string
  /**
   * Why there are no options YET, when that's a step the author hasn't taken
   * rather than a schema that doesn't exist ("Select a tool first"). Renders as
   * an inert dropdown, so the field reads as one that will fill in rather than
   * as a box to type a path into.
   */
  pathPending?: string | null
  onChange: (patch: {
    path?: string
    match?: EvalMatch
    value?: unknown
  }) => void
}) {
  const { Input, Label } = useWfComponents()
  const pathField = useCommittedField(path ?? '', (p) => {
    return onChange({ path: p || undefined })
  })
  const valueField = useCommittedField(valueToStr(value), (v) => {
    return onChange({ value: parseValue(v) })
  })

  const selectedField = pathOptions?.find((o) => o.value === (path ?? ''))
  // Preserve a stored path that isn't in the schema (nested/custom) as its own
  // option so switching targets or hand-authored paths never silently vanish.
  const showsCustom = Boolean(
    pathOptions && path && !pathOptions.some((o) => o.value === path),
  )

  const valueOptions = selectedField?.values
  // A field with a closed set of values is compared ONE way — `equals` for a
  // scalar, `contains` (membership) for a list. The value was picked from the
  // field's own list, so a substring or a regex of it is the same assertion
  // written less clearly, and the other modes are unreachable: `contains`
  // against a boolean never holds, `equals` against a list never does either.
  // A stored match stays offered rather than silently re-rendering as something
  // the check doesn't say.
  const matchOptions = valueOptions
    ? MATCH_OPTIONS.filter(
        (m) => m === selectedField?.valueMatch || m === match,
      )
    : MATCH_OPTIONS

  // Switching to a field with declared values re-points the whole row at it: its
  // comparison, and an expected value that has to be one of the NEW field's (the
  // previous one belonged to a different field, so keeping it would leave a
  // check that reads plausibly and can never pass).
  const selectPath = (next: string | undefined) => {
    const option = pathOptions?.find((o) => o.value === (next ?? ''))
    if (!option?.values || !option.valueMatch) return onChange({ path: next })
    const kept = option.values.some((v) => toText(v) === toText(value))
    onChange({
      path: next,
      match: option.valueMatch,
      value: kept ? value : '',
    })
  }

  return (
    <div className="space-y-1">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label>{pathLabel}</Label>
          {pathOptions ? (
            <select
              value={path ?? ''}
              onChange={(e) => selectPath(e.target.value || undefined)}
              className="h-9 w-full rounded-md border border-neutral-300 bg-transparent px-2 text-sm outline-none focus:border-neutral-500"
            >
              <option value="">{wholeLabel}</option>
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
          ) : pathPending ? (
            <select
              disabled
              value=""
              className="h-9 w-full rounded-md border border-neutral-200 bg-transparent px-2 text-sm text-neutral-400 outline-none"
            >
              <option value="">{pathPending}</option>
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
            {matchOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label>Value</Label>
          {valueOptions ? (
            <ValuePicker
              value={value}
              options={valueOptions}
              onChange={(next) => onChange({ value: next })}
            />
          ) : (
            <Input
              value={valueField.value}
              placeholder="expected"
              onChange={(e) => valueField.onChange(e.target.value)}
              onBlur={valueField.onBlur}
              className="font-mono text-xs"
            />
          )}
        </div>
      </div>
      {selectedField?.description ? (
        <p className="text-xs text-neutral-400">{selectedField.description}</p>
      ) : null}
    </div>
  )
}

// The expected value, as a picker over a field's declared values. Options are
// round-tripped through the declared list on the way out, so a boolean or
// numeric member is stored as itself rather than as its text form — the check
// compares with deep equality, where `"true"` and `true` are different answers.
function ValuePicker({
  value,
  options,
  onChange,
}: {
  value: unknown
  options: unknown[]
  onChange: (next: unknown) => void
}) {
  const text = toText(value)
  // A stored value the field no longer declares stays visible and selected —
  // the same reason a custom path does. Silently showing the first member
  // instead would misreport what the check asserts.
  const stale = text !== '' && !options.some((o) => toText(o) === text)
  return (
    <select
      value={text}
      onChange={(e) => {
        const picked = options.find((o) => toText(o) === e.target.value)
        onChange(picked ?? '')
      }}
      className="h-9 w-full rounded-md border border-neutral-300 bg-transparent px-2 text-sm outline-none focus:border-neutral-500"
    >
      <option value="">expected…</option>
      {options.map((o) => (
        <option key={toText(o)} value={toText(o)}>
          {toText(o)}
        </option>
      ))}
      {stale ? <option value={text}>{text} (not declared)</option> : null}
    </select>
  )
}
