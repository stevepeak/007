import { useEffect, useMemo, useState } from 'react'

import type { JsonSchema } from '../server/protocol'
import { useWfComponents } from './context'

// A form for a tool's input arguments, generated from its JSON Schema (converted
// from the tool's Zod `inputSchema` on the server). It renders a labelled field
// per top-level property — text / number / checkbox / select — and falls back to
// a JSON textarea for anything it can't map to a simple control (arrays, nested
// objects, unions). Values are kept as raw strings and coerced on every change;
// the built args (or `null` when a JSON field is mid-edit and unparseable) are
// pushed up via `onArgsChange` so the parent can gate its Run button.
//
// The form is intentionally lenient: it only emits the fields the user filled
// in, letting the tool's own schema apply defaults and raise precise errors when
// the real call runs. That keeps this generic renderer from having to reproduce
// every Zod validation rule.

type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'json'

type Field = {
  name: string
  type: FieldType
  required: boolean
  title: string
  description?: string
  enumValues?: unknown[]
  default?: unknown
  /** Long strings render as a textarea rather than a single-line input. */
  multiline?: boolean
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

// Derive a flat field list from a JSON Schema object. Non-object schemas (or an
// absent schema) yield an empty list — the caller then shows a raw JSON editor.
function fieldsFromSchema(schema: JsonSchema | undefined): Field[] {
  if (!schema) return []
  const props = asObject(schema.properties)
  if (!props) return []
  const required = new Set(
    Array.isArray(schema.required) ? (schema.required as string[]) : [],
  )
  const fields: Field[] = []
  for (const [name, raw] of Object.entries(props)) {
    const p = asObject(raw) ?? {}
    const description =
      typeof p.description === 'string' ? p.description : undefined
    const title = typeof p.title === 'string' ? p.title : name
    const base = {
      name,
      required: required.has(name),
      title,
      description,
      default: p.default,
    }
    if (Array.isArray(p.enum)) {
      fields.push({ ...base, type: 'enum', enumValues: p.enum })
      continue
    }
    const t = p.type
    if (t === 'boolean') {
      fields.push({ ...base, type: 'boolean' })
    } else if (t === 'integer') {
      fields.push({ ...base, type: 'integer' })
    } else if (t === 'number') {
      fields.push({ ...base, type: 'number' })
    } else if (t === 'string') {
      // A `format` hint or an explicit long description → treat as multiline.
      const multiline = p.format === 'textarea'
      fields.push({ ...base, type: 'string', multiline })
    } else {
      // Arrays, nested objects, unions (anyOf/oneOf), or untyped — edit as JSON.
      fields.push({ ...base, type: 'json' })
    }
  }
  return fields
}

// Initial raw string for a field, seeded from its schema default when present.
function initialRaw(field: Field): string {
  if (field.default === undefined) return ''
  if (field.type === 'json') return JSON.stringify(field.default, null, 2)
  if (field.type === 'boolean') return ''
  return String(field.default)
}

export type ToolFormProps = {
  /** The tool's input schema (JSON Schema). Undefined → raw JSON editor. */
  schema: JsonSchema | undefined
  /** Disable all inputs (e.g. while a run is in flight). */
  disabled?: boolean
  /**
   * Called on every edit with the coerced args, or `null` when a field can't be
   * parsed (a malformed JSON field) so the parent can disable submission.
   */
  onArgsChange: (args: Record<string, unknown> | null) => void
}

export function ToolForm({ schema, disabled, onArgsChange }: ToolFormProps) {
  const { Input, Label, Textarea } = useWfComponents()
  const fields = useMemo(() => fieldsFromSchema(schema), [schema])
  const hasFields = fields.length > 0

  // Raw string state for scalar/enum/json fields, and booleans separately.
  const [raw, setRaw] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.name, initialRaw(f)])),
  )
  const [bools, setBools] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      fields
        .filter((f) => f.type === 'boolean')
        .map((f) => [f.name, f.default === true]),
    ),
  )
  // Whole-args JSON editor, used when the schema isn't a plain object.
  const [rawJson, setRawJson] = useState('{}')

  // Re-seed when the schema (tool) changes.
  useEffect(() => {
    setRaw(Object.fromEntries(fields.map((f) => [f.name, initialRaw(f)])))
    setBools(
      Object.fromEntries(
        fields
          .filter((f) => f.type === 'boolean')
          .map((f) => [f.name, f.default === true]),
      ),
    )
    setRawJson('{}')
  }, [fields])

  // Coerce the current inputs into an args object (or null when invalid) and
  // report upward whenever anything changes.
  useEffect(() => {
    if (!hasFields) {
      const trimmed = rawJson.trim()
      if (!trimmed) {
        onArgsChange({})
        return
      }
      try {
        const parsed = JSON.parse(trimmed)
        onArgsChange(asObject(parsed) ?? null)
      } catch {
        onArgsChange(null)
      }
      return
    }
    const args: Record<string, unknown> = {}
    for (const f of fields) {
      if (f.type === 'boolean') {
        args[f.name] = bools[f.name] ?? false
        continue
      }
      const value = raw[f.name] ?? ''
      if (value === '') continue // let the tool schema supply the default
      if (f.type === 'number' || f.type === 'integer') {
        const n = Number(value)
        if (Number.isNaN(n)) {
          onArgsChange(null)
          return
        }
        args[f.name] = n
      } else if (f.type === 'enum') {
        // Match the raw string back to the typed enum member (numbers/booleans).
        const match = f.enumValues?.find((e) => String(e) === value)
        args[f.name] = match ?? value
      } else if (f.type === 'json') {
        try {
          args[f.name] = JSON.parse(value)
        } catch {
          onArgsChange(null)
          return
        }
      } else {
        args[f.name] = value
      }
    }
    onArgsChange(args)
  }, [fields, hasFields, raw, bools, rawJson, onArgsChange])

  if (!hasFields) {
    return (
      <div className="space-y-1.5">
        <Label htmlFor="tool-raw-args">
          Arguments (JSON)
          {schema ? null : (
            <span className="ml-1 text-neutral-400">
              — this tool declares no input schema
            </span>
          )}
        </Label>
        <Textarea
          id="tool-raw-args"
          value={rawJson}
          disabled={disabled}
          onChange={(e) => setRawJson(e.target.value)}
          rows={6}
          spellCheck={false}
          className="w-full rounded-md border border-neutral-300 p-2 font-mono text-xs"
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {fields.map((f) => {
        const id = `tool-arg-${f.name}`
        return (
          <div key={f.name} className="space-y-1.5">
            {f.type === 'boolean' ? (
              <label
                htmlFor={id}
                className="flex items-center gap-2 text-sm font-medium text-neutral-800"
              >
                <input
                  id={id}
                  type="checkbox"
                  disabled={disabled}
                  checked={bools[f.name] ?? false}
                  onChange={(e) =>
                    setBools((b) => ({ ...b, [f.name]: e.target.checked }))
                  }
                  className="size-4 rounded border-neutral-300"
                />
                {f.title}
                {f.required ? <RequiredMark /> : null}
              </label>
            ) : (
              <Label htmlFor={id}>
                {f.title}
                {f.required ? <RequiredMark /> : null}
                <TypeHint field={f} />
              </Label>
            )}

            {f.description ? (
              <p className="text-xs text-neutral-500">{f.description}</p>
            ) : null}

            {f.type === 'boolean' ? null : f.type === 'enum' ? (
              <select
                id={id}
                disabled={disabled}
                value={raw[f.name] ?? ''}
                onChange={(e) =>
                  setRaw((r) => ({ ...r, [f.name]: e.target.value }))
                }
                className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm"
              >
                <option value="">
                  {f.required ? 'Select…' : '(use default)'}
                </option>
                {f.enumValues?.map((e) => (
                  <option key={String(e)} value={String(e)}>
                    {String(e)}
                  </option>
                ))}
              </select>
            ) : f.type === 'json' ? (
              <Textarea
                id={id}
                value={raw[f.name] ?? ''}
                disabled={disabled}
                placeholder={f.required ? '' : '(use default)'}
                onChange={(e) =>
                  setRaw((r) => ({ ...r, [f.name]: e.target.value }))
                }
                rows={4}
                spellCheck={false}
                className="w-full rounded-md border border-neutral-300 p-2 font-mono text-xs"
              />
            ) : f.type === 'string' && f.multiline ? (
              <Textarea
                id={id}
                value={raw[f.name] ?? ''}
                disabled={disabled}
                onChange={(e) =>
                  setRaw((r) => ({ ...r, [f.name]: e.target.value }))
                }
                rows={4}
                className="w-full rounded-md border border-neutral-300 p-2 text-sm"
              />
            ) : (
              <Input
                id={id}
                type={
                  f.type === 'number' || f.type === 'integer'
                    ? 'number'
                    : 'text'
                }
                value={raw[f.name] ?? ''}
                disabled={disabled}
                placeholder={f.required ? '' : '(use default)'}
                onChange={(e) =>
                  setRaw((r) => ({ ...r, [f.name]: e.target.value }))
                }
                className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm"
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

function RequiredMark() {
  return <span className="ml-0.5 text-red-500">*</span>
}

function TypeHint({ field }: { field: Field }) {
  const label =
    field.type === 'json'
      ? 'json'
      : field.type === 'integer'
        ? 'integer'
        : field.type
  return (
    <span className="ml-1.5 font-mono text-[11px] font-normal text-neutral-400">
      {label}
    </span>
  )
}
