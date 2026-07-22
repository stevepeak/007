import type { FieldConfig, ParsedField } from '@autoform/core'

import { asObject, type FieldKind } from './json-schema-helpers'

// Convert one JSON Schema property into an AutoForm ParsedField. `order`
// preserves the schema's property order through AutoForm's stable sort.
export function parseField(
  key: string,
  raw: unknown,
  required: boolean,
  order: number,
): ParsedField {
  const p = asObject(raw) ?? {}
  const title = typeof p.title === 'string' ? p.title : undefined
  const description =
    typeof p.description === 'string' ? p.description : undefined

  const fieldConfig: FieldConfig = { order }
  if (title) fieldConfig.label = title
  if (description) fieldConfig.description = description

  const base = { key, required, default: p.default, fieldConfig }

  // enum → a select of its members. Keep the original typed values around so
  // numeric/boolean enums can be coerced back on submit.
  if (Array.isArray(p.enum)) {
    fieldConfig.customData = { enumValues: p.enum }
    return {
      ...base,
      type: 'select' satisfies FieldKind,
      options: p.enum.map((v) => [String(v), String(v)] as [string, string]),
    }
  }

  const t = p.type
  if (t === 'boolean') return { ...base, type: 'boolean' satisfies FieldKind }

  if (t === 'integer' || t === 'number') {
    fieldConfig.inputProps = {
      ...(asObject(fieldConfig.inputProps) ?? {}),
      inputMode: 'decimal',
      step: t === 'integer' ? 1 : 'any',
    }
    return { ...base, type: 'number' satisfies FieldKind }
  }

  if (t === 'string') {
    // Our own convention (also honoured by the legacy renderer): a `textarea`
    // format hint renders a multi-line control.
    const multiline = p.format === 'textarea'
    return {
      ...base,
      type: (multiline ? 'textarea' : 'string') satisfies FieldKind,
    }
  }

  if (t === 'object' && asObject(p.properties)) {
    return { ...base, type: 'object' satisfies FieldKind, schema: parseFields(p) }
  }

  if (t === 'array' && p.items !== undefined) {
    // AutoForm reads `schema[0]` as the element spec. Blank its label — the
    // ArrayElementWrapper already numbers each row ("Item 1", …).
    const item = parseField('', p.items, true, 0)
    item.fieldConfig = { ...(item.fieldConfig ?? {}), label: '' }
    return { ...base, type: 'array' satisfies FieldKind, schema: [item] }
  }

  // Unions (anyOf/oneOf), tuples, or untyped → edit as raw JSON.
  return { ...base, type: 'json' satisfies FieldKind }
}

// Parse the `properties` of an object schema into an ordered field list.
export function parseFields(schema: Record<string, unknown>): ParsedField[] {
  const props = asObject(schema.properties)
  if (!props) return []
  const required = new Set(
    Array.isArray(schema.required) ? (schema.required as string[]) : [],
  )
  return Object.entries(props).map(([name, raw], i) =>
    parseField(name, raw, required.has(name), i),
  )
}

// Initial form values, so every control is controlled from the first render.
export function defaultsFor(fields: ParsedField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) out[f.key] = defaultForField(f)
  return out
}

function defaultForField(f: ParsedField): unknown {
  if (f.default !== undefined) {
    // JSON fields hold raw text, so pretty-print an object default.
    return f.type === 'json' ? JSON.stringify(f.default, null, 2) : f.default
  }
  switch (f.type as FieldKind) {
    case 'boolean':
      return false
    case 'array':
      return []
    case 'object':
      return f.schema ? defaultsFor(f.schema) : {}
    default:
      // string / textarea / number / select / json all start empty.
      return ''
  }
}
