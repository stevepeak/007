import { z } from 'zod'

import type { JsonSchema } from '../../server/protocol'

import { asObject } from './json-schema-helpers'

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
export function buildZodSchema(schema: Record<string, unknown> | null): z.ZodType {
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
