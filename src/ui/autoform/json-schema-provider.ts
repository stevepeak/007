import type {
  FieldConfig,
  ParsedField,
  ParsedSchema,
  SchemaProvider,
  SchemaType,
  SchemaValidation,
} from '@autoform/core'
import { z } from 'zod'

import type { JsonSchema } from '../../server/protocol'

// AutoForm's official schema providers (ZodProvider, …) expect a live schema
// *object*. The playground only ever has a JSON Schema on the client — the Zod
// definitions live server-side and are converted with `z.toJSONSchema` before
// they cross the wire. So we implement AutoForm's `SchemaProvider` interface
// directly against JSON Schema: parse it into AutoForm's `ParsedSchema` for
// rendering, and keep the wire format as the single source of truth.
//
// Validation: AutoForm's react-hook-form adapter *always* wires a resolver and
// only knows how to build one for `zod | yup | joi`, so we advertise
// `schemaType: 'zod'` and, in `getSchema()`, compile the SAME JSON Schema into a
// real Zod schema (`jsonSchemaToZod`, dependency-free — JSON Schema stays the
// single source of truth). That gives genuine, per-field client-side validation
// (required, min/max, patterns, JSON well-formedness), surfaced inline through
// the FieldWrapper. Controls hold raw strings, so number/integer fields compile
// to `z.coerce.number()`; `coerceValues` still produces the final typed args at
// submit. The server remains the authoritative validator when the run executes;
// if a schema can't be compiled we fall back to a permissive `looseObject`.

type FieldKind =
  | 'string'
  | 'textarea'
  | 'number'
  | 'boolean'
  | 'select'
  | 'json'
  | 'object'
  | 'array'

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

/** True for `{}` — used to detect a genuinely empty object schema. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return asObject(v) !== null
}

// Convert one JSON Schema property into an AutoForm ParsedField. `order`
// preserves the schema's property order through AutoForm's stable sort.
function parseField(
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
function parseFields(schema: Record<string, unknown>): ParsedField[] {
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
function defaultsFor(fields: ParsedField[]): Record<string, unknown> {
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

// --- Sample stub generation (mock-output authoring) --------------------------
//
// Produce a fill-in-the-blanks placeholder object from a JSON Schema, so an
// author editing a mock tool output starts from the tool's shape with typed
// blanks — e.g. `{ "memories": [{ "id": "<string>", "content": "<string>" }] }`
// — instead of a bare `{}`. Leaves become `"<type>"` hints; a schema-provided
// default/example wins when present.

function firstBranch(list: unknown): unknown | undefined {
  if (!Array.isArray(list)) return undefined
  // Prefer a non-null branch so `T | null` samples as a T.
  return list.find((b) => asObject(b)?.type !== 'null') ?? list[0]
}

function sampleForProp(raw: unknown): unknown {
  const p = asObject(raw) ?? {}

  // An author-facing example/default is the best possible stub.
  if (p.default !== undefined) return p.default
  if (Array.isArray(p.examples) && p.examples.length > 0) return p.examples[0]
  if (p.example !== undefined) return p.example

  // enum → show the choices inline so the author knows the options.
  if (Array.isArray(p.enum)) {
    return p.enum.length > 0
      ? `<${p.enum.map((v) => String(v)).join(' | ')}>`
      : '<string>'
  }

  // Unions/nullable-via-anyOf → sample the first (non-null) branch.
  const branch = firstBranch(p.anyOf) ?? firstBranch(p.oneOf)
  if (branch !== undefined) return sampleForProp(branch)

  // `type: ['string','null']` → sample the non-null member.
  const t = Array.isArray(p.type) ? p.type.find((x) => x !== 'null') : p.type

  if (t === 'boolean') return '<boolean>'
  if (t === 'integer' || t === 'number') return '<number>'
  if (t === 'string') {
    if (p.format === 'email') return '<email>'
    if (p.format === 'url' || p.format === 'uri') return '<url>'
    return '<string>'
  }
  if (t === 'object' && asObject(p.properties)) return sampleForObject(p)
  if (t === 'array' && p.items !== undefined) return [sampleForProp(p.items)]

  // Untyped / unmodelable → a generic blank.
  return '<any>'
}

function sampleForObject(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const props = asObject(schema.properties) ?? {}
  const out: Record<string, unknown> = {}
  for (const [name, raw] of Object.entries(props)) out[name] = sampleForProp(raw)
  return out
}

// Build a fill-in-the-blanks sample object from a JSON Schema, or undefined when
// the schema doesn't resolve to an object (the caller falls back to `{}`).
export function sampleFromSchema(
  schema: JsonSchema | undefined,
): Record<string, unknown> | undefined {
  const obj = asObject(schema)
  if (!obj) return undefined
  const sample = sampleForProp(obj)
  return isPlainObject(sample) ? sample : undefined
}

// --- JSON Schema → Zod (for client-side validation) --------------------------
//
// Compiles a JSON Schema into a Zod schema that validates the RAW form values
// (see the header). It intentionally mirrors `parseField`'s type decisions so
// the validator matches what's rendered: number/integer → `z.coerce.number()`
// (controls hold strings), enums/selects validate on their string form, and
// unions/untyped fields validate as well-formed JSON text. Empty controls are
// normalised to `undefined` by AutoForm before the resolver runs, so `optional()`
// cleanly distinguishes required-but-blank from optional-and-blank.

const NUMERIC = new Set(['number', 'integer'])

// Human label used in validation messages. Prefers the schema `title`, else a
// beautified key — matching the label AutoForm renders above the field, so a
// message reads "Age is required." for the field shown as "Age".
function labelFor(name: string, prop: Record<string, unknown>): string {
  if (typeof prop.title === 'string' && prop.title) return prop.title
  const out = name.replace(/([A-Z])/g, ' $1').trim()
  return out.charAt(0).toUpperCase() + out.slice(1)
}

// Require a value to be present with a clean "<Label> is required." message,
// then hand present values off to `base` for the type/constraint checks. Empty
// controls arrive as `undefined` (AutoForm normalises '' → undefined), so `base`
// only ever runs on real input.
function finalize(
  base: z.ZodType,
  required: boolean,
  nullable: boolean,
  label: string,
): z.ZodType {
  const inner = nullable ? base.nullable() : base
  if (!required) return inner.optional()
  return z
    .any()
    .refine(
      (v) => v !== undefined && v !== null && v !== '',
      `${label} is required.`,
    )
    .pipe(inner)
}

function zodForProp(
  raw: unknown,
  required: boolean,
  label: string,
): z.ZodType {
  const p = asObject(raw) ?? {}

  // enum → validated against the string form the <select> stores.
  if (Array.isArray(p.enum)) {
    const values = p.enum.map((v) => String(v))
    const base =
      values.length > 0
        ? z.enum(values as [string, ...string[]], {
            error: `${label} must be one of: ${values.join(', ')}.`,
          })
        : z.string()
    return finalize(base, required, false, label)
  }

  // `type: ['string','null']` → take the non-null type, allow null.
  const rawType = Array.isArray(p.type)
    ? p.type.find((t) => t !== 'null')
    : p.type
  const nullable = Array.isArray(p.type) && p.type.includes('null')

  let base: z.ZodType
  if (rawType === 'boolean') {
    base = z.boolean()
  } else if (NUMERIC.has(String(rawType))) {
    let n = z.coerce.number()
    if (typeof p.minimum === 'number')
      n = n.min(p.minimum, `${label} must be at least ${p.minimum}.`)
    if (typeof p.maximum === 'number')
      n = n.max(p.maximum, `${label} must be at most ${p.maximum}.`)
    if (typeof p.exclusiveMinimum === 'number')
      n = n.gt(p.exclusiveMinimum, `${label} must be greater than ${p.exclusiveMinimum}.`)
    if (typeof p.exclusiveMaximum === 'number')
      n = n.lt(p.exclusiveMaximum, `${label} must be less than ${p.exclusiveMaximum}.`)
    if (typeof p.multipleOf === 'number')
      n = n.multipleOf(p.multipleOf, `${label} must be a multiple of ${p.multipleOf}.`)
    base =
      rawType === 'integer'
        ? n.refine((x) => Number.isInteger(x), `${label} must be a whole number.`)
        : n
  } else if (rawType === 'string') {
    let s = z.string()
    if (typeof p.minLength === 'number')
      s = s.min(p.minLength, `${label} must be at least ${p.minLength} character${p.minLength === 1 ? '' : 's'}.`)
    if (typeof p.maxLength === 'number')
      s = s.max(p.maxLength, `${label} must be at most ${p.maxLength} character${p.maxLength === 1 ? '' : 's'}.`)
    if (typeof p.pattern === 'string') {
      try {
        s = s.regex(new RegExp(p.pattern), `${label} has an invalid format.`)
      } catch {
        // Ignore an unparseable pattern rather than break the whole form.
      }
    }
    base = applyStringFormat(s, p.format, label)
  } else if (rawType === 'object' && asObject(p.properties)) {
    base = zodForObject(p)
  } else if (rawType === 'array' && p.items !== undefined) {
    // Array items are optional so a blank new row doesn't block submit —
    // `coerceValues` drops empties. Non-empty invalid items still fail.
    let a = z.array(zodForProp(p.items, false, `${label} item`))
    if (typeof p.minItems === 'number')
      a = a.min(p.minItems, `${label} must have at least ${p.minItems} item${p.minItems === 1 ? '' : 's'}.`)
    if (typeof p.maxItems === 'number')
      a = a.max(p.maxItems, `${label} must have at most ${p.maxItems} item${p.maxItems === 1 ? '' : 's'}.`)
    base = a
  } else {
    // Unions (anyOf/oneOf), tuples, or untyped → a JSON text field.
    base = z.string().refine((v) => isValidJson(v), `${label} must be valid JSON.`)
  }

  return finalize(base, required, nullable, label)
}

function applyStringFormat(
  s: z.ZodString,
  format: unknown,
  label: string,
): z.ZodType {
  // Use refinements rather than Zod's format helpers so we stay agnostic to
  // Zod's evolving format API and can keep any length/pattern checks above.
  if (format === 'email') {
    return s.refine(
      (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v),
      `${label} must be a valid email.`,
    )
  }
  if (format === 'url' || format === 'uri') {
    return s.refine((v) => {
      try {
        new URL(v)
        return true
      } catch {
        return false
      }
    }, `${label} must be a valid URL.`)
  }
  return s
}

function zodForObject(schema: Record<string, unknown>): z.ZodType {
  const props = asObject(schema.properties) ?? {}
  const required = new Set(
    Array.isArray(schema.required) ? (schema.required as string[]) : [],
  )
  const shape: Record<string, z.ZodType> = {}
  for (const [name, raw] of Object.entries(props)) {
    const prop = asObject(raw) ?? {}
    shape[name] = zodForProp(raw, required.has(name), labelFor(name, prop))
  }
  return z.object(shape)
}

function isValidJson(v: string): boolean {
  if (v.trim() === '') return true // empty handled by optional()/coerceValues
  try {
    JSON.parse(v)
    return true
  } catch {
    return false
  }
}

// Compile the root schema, falling back to a permissive object if anything in
// the JSON Schema is shaped in a way we don't model (so the form never breaks).
function buildZodSchema(schema: Record<string, unknown> | null): z.ZodType {
  if (!schema) return z.looseObject({})
  try {
    return zodForObject(schema)
  } catch {
    return z.looseObject({})
  }
}

// Validate a natural (typed) value against a JSON Schema, reusing the same
// compiled Zod. Permissive by design — coercion mirrors the form controls — so
// it flags genuine shape/`required` mismatches without false alarms. Used for
// the mock-output editor's warn-but-allow check. Returns human-readable paths.
export function validateAgainstSchema(
  schema: JsonSchema | undefined,
  value: unknown,
): { ok: boolean; errors: string[] } {
  const obj = asObject(schema)
  if (!obj) return { ok: true, errors: [] }
  const result = buildZodSchema(obj).safeParse(value)
  if (result.success) return { ok: true, errors: [] }
  return {
    ok: false,
    errors: result.error.issues.map((issue) => {
      const path = issue.path.join('.')
      return path ? `${path}: ${issue.message}` : issue.message
    }),
  }
}

export class JsonSchemaProvider implements SchemaProvider {
  readonly schemaType: SchemaType = 'zod'
  private readonly fields: ParsedField[]
  // Real per-field validator compiled from the same JSON Schema. Falls back to
  // a permissive object schema when the schema can't be modelled.
  private readonly zodSchema: z.ZodType

  constructor(schema: JsonSchema | undefined) {
    const obj = asObject(schema)
    this.fields = obj ? parseFields(obj) : []
    this.zodSchema = buildZodSchema(obj)
  }

  parseSchema(): ParsedSchema {
    return { fields: this.fields }
  }

  getDefaultValues(): Record<string, unknown> {
    return defaultsFor(this.fields)
  }

  validateSchema(values: unknown): SchemaValidation {
    const result = this.zodSchema.safeParse(values)
    if (result.success) return { success: true, data: result.data }
    return {
      success: false,
      errors: result.error.issues.map((issue) => ({
        path: issue.path as (string | number)[],
        message: issue.message,
      })),
    }
  }

  getSchema() {
    return this.zodSchema
  }

  getFields(): ParsedField[] {
    return this.fields
  }

  /** Whether the schema yielded any renderable fields (else: raw-JSON fallback). */
  get hasFields(): boolean {
    return this.fields.length > 0
  }
}

export type CoerceResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string }

// Field controls store raw strings (a number as text, an object as JSON, …) so
// intermediate keystrokes never blow up. This walks the parsed fields and turns
// those raw values into the typed args to send, mirroring the legacy renderer:
// empty values are omitted so the tool/agent schema can apply its own defaults.
export function coerceValues(
  values: Record<string, unknown>,
  fields: ParsedField[],
): CoerceResult {
  try {
    return { ok: true, data: coerceObject(values, fields) }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

const OMIT = Symbol('omit')

function labelOf(f: ParsedField): string {
  const l = f.fieldConfig?.label
  return (typeof l === 'string' && l) || f.key || 'value'
}

function coerceObject(
  values: unknown,
  fields: ParsedField[],
): Record<string, unknown> {
  const src = asObject(values) ?? {}
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    const c = coerceField(src[f.key], f)
    if (c !== OMIT) out[f.key] = c
  }
  return out
}

function coerceField(v: unknown, f: ParsedField): unknown | typeof OMIT {
  switch (f.type as FieldKind) {
    case 'boolean':
      return v === true

    case 'number': {
      if (v === '' || v == null) return OMIT
      const n = Number(v)
      if (Number.isNaN(n)) throw new Error(`"${labelOf(f)}" must be a number.`)
      return n
    }

    case 'select': {
      if (v === '' || v == null) return OMIT
      const enumValues = f.fieldConfig?.customData?.enumValues as
        | unknown[]
        | undefined
      const match = enumValues?.find((e) => String(e) === String(v))
      return match ?? v
    }

    case 'json': {
      if (typeof v !== 'string' || v.trim() === '') return OMIT
      try {
        return JSON.parse(v)
      } catch {
        throw new Error(`"${labelOf(f)}" is not valid JSON.`)
      }
    }

    case 'object': {
      const nested = coerceObject(v, f.schema ?? [])
      return Object.keys(nested).length > 0 ? nested : OMIT
    }

    case 'array': {
      if (!Array.isArray(v)) return OMIT
      const item = f.schema?.[0]
      if (!item) return v
      const arr: unknown[] = []
      for (const el of v) {
        const c = coerceField(el, item)
        if (c !== OMIT) arr.push(c)
      }
      return arr
    }

    default: {
      // string / textarea
      if (v === '' || v == null) return OMIT
      return v
    }
  }
}
