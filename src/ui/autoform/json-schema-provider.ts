import type {
  ParsedField,
  ParsedSchema,
  SchemaProvider,
  SchemaType,
  SchemaValidation,
} from '@autoform/core'
import { z } from 'zod'

import type { JsonSchema } from '../../server/protocol'

import { asObject, type FieldKind } from './json-schema-helpers'
import { defaultsFor, parseFields } from './json-schema-parse'
import { buildZodSchema } from './json-schema-validate'

export { isPlainObject } from './json-schema-helpers'
export { sampleFromSchema } from './json-schema-sample'
export { validateAgainstSchema } from './json-schema-validate'

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
