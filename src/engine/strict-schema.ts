// The strict JSON Schema dialect — what a provider will actually honor when it
// constrains a model's output, and the gap between that and what `z.toJSONSchema`
// emits.
//
// Zod is a validator; the JSON Schema it prints is a faithful description of what
// it will accept. Structured-output modes (OpenAI `response_format: json_schema`
// with `strict: true`, and every provider that copied it — Venice, OpenRouter's
// pass-through) accept only a SUBSET of JSON Schema, and the three differences
// that matter are:
//
//   • `oneOf` is not supported; only `anyOf` is. Zod emits `oneOf` for a
//     discriminated union.
//   • Bounds and formats (`minItems`, `minLength`, `minimum`, `pattern`,
//     `format`, …) are rejected outright.
//   • EVERY property must appear in `required`, and every object must set
//     `additionalProperties: false`. Optionality is expressed by widening the
//     property's type to include `null`, never by leaving it out of `required`.
//
// The failure is silent and provider-specific, which is why this exists as a
// deliberate pass rather than a footnote. Measured against one schema carrying a
// discriminated union: Venice deepseek returned `null` for absent optionals (the
// zod `.optional()` then rejected it → `NoObjectGeneratedError`), Venice
// `openai-gpt-54-mini` returned HTTP 400, and Claude via OpenRouter returned
// HTTP 200 with unconstrained Markdown prose — the schema silently dropped, no
// error anywhere. A tool with a union in its input presents as flaky model
// behavior rather than as a bug we own.
//
// Zod stays the validator. Only the schema SENT TO THE MODEL is transformed —
// `strictSchema` keeps the original zod type as the `validate` step, so runtime
// acceptance is unchanged apart from the one deliberate widening below (a `null`
// standing in for an absent optional is coerced back to `undefined`, since that
// null is an artifact of this dialect, not something the author asked for).
//
// AUTHORING CONVENTION: for anything a MODEL fills — a tool's `inputSchema`, a
// `generateObject` schema — write `.nullish()`, not `.optional()`. Under strict
// mode the property is required either way; `.nullish()` is the shape that
// matches what the provider will send back.

import {
  asSchema,
  type FlexibleSchema,
  jsonSchema,
  type Schema,
  type Tool,
} from 'ai'
import { z } from 'zod'

import type { JsonSchema } from './agent-output-scan'

/**
 * Keywords a strict structured-output schema may not carry. Zod emits these from
 * `.min()` / `.max()` / `.regex()` / `.email()` and friends. They are dropped
 * rather than translated: there is no strict-mode equivalent, and a constraint
 * the model never sees is better expressed in a `.describe()` it does.
 *
 * Note that dropping them costs nothing at runtime — the zod schema still
 * enforces every one of them on the value that comes back.
 */
const UNSUPPORTED_KEYWORDS = [
  // strings
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'contentEncoding',
  'contentMediaType',
  // numbers
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  // arrays
  'minItems',
  'maxItems',
  'uniqueItems',
  'contains',
  'minContains',
  'maxContains',
  'unevaluatedItems',
  // objects
  'minProperties',
  'maxProperties',
  'patternProperties',
  'propertyNames',
  'unevaluatedProperties',
  // schema composition the dialect does not accept
  'not',
  'if',
  'then',
  'else',
  'dependentSchemas',
  'dependentRequired',
] as const

/** Subschema-valued keywords whose value is itself a schema. */
const SCHEMA_KEYWORDS = ['items', 'additionalItems'] as const

/** Subschema-valued keywords whose value is an ARRAY of schemas. */
const SCHEMA_LIST_KEYWORDS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'] as const

/** Keywords whose value is a map of name → schema. */
const SCHEMA_MAP_KEYWORDS = ['properties', '$defs', 'definitions'] as const

/**
 * The JSON Schema value the AI SDK hands a provider, derived from `jsonSchema`'s
 * own parameter so it tracks the SDK instead of re-declaring draft-7 here.
 */
type ProviderJsonSchema = Awaited<
  Exclude<Parameters<typeof jsonSchema>[0], () => unknown>
>

function isSchemaObject(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a node already admits `null` — either as a bare type, inside a
 * `type: [...]` list, or as a branch of a union. Used so widening an optional
 * property never doubles up a null that is already there.
 */
function admitsNull(schema: JsonSchema): boolean {
  const t = schema.type
  if (t === 'null') return true
  if (Array.isArray(t) && t.includes('null')) return true
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = schema[key]
    if (
      Array.isArray(branches) &&
      branches.some((b) => isSchemaObject(b) && admitsNull(b))
    ) {
      return true
    }
  }
  return false
}

/**
 * Widen a schema so it also accepts `null`, which is how strict mode expresses
 * "this may be absent" now that every property is required.
 *
 * Prefers the `type: [t, 'null']` form for a plain typed node — it keeps the
 * node a single schema, so a sibling `enum` / `items` / `description` still
 * applies — and falls back to an `anyOf` union for anything composite.
 */
function withNull(schema: JsonSchema): JsonSchema {
  if (admitsNull(schema)) return schema
  const t = schema.type
  if (typeof t === 'string') return { ...schema, type: [t, 'null'] }
  if (Array.isArray(t)) {
    return { ...schema, type: [...(t as unknown[]), 'null'] }
  }
  // No `type` of its own (a union, a `$ref`, an untyped `{}`): union it with
  // null, carrying the description up so the model still reads it on the
  // property rather than on a branch it may not surface.
  const { description, ...rest } = schema
  const node: JsonSchema = { anyOf: [rest, { type: 'null' }] }
  if (description !== undefined) node.description = description
  return node
}

/**
 * Rewrite a JSON Schema into the strict dialect a provider will honor.
 *
 * Pure and structural — it never looks at a value. Three transforms, applied at
 * every depth including inside `$defs`:
 *
 *   1. `oneOf` → `anyOf`.
 *   2. Unsupported keywords ({@link UNSUPPORTED_KEYWORDS}) dropped.
 *   3. Every object with declared `properties` gets `required` set to ALL of
 *      them plus `additionalProperties: false`, and each property that was NOT
 *      previously required is widened to accept `null`.
 *
 * An object with no `properties` (a `z.record`, a bare `{ type: 'object' }`) is
 * left alone: it has nothing to require, and strict mode has no way to express
 * an open map, so forcing `additionalProperties: false` would turn a permissive
 * schema into one that admits nothing at all.
 */
export function strictifyJsonSchema(schema: JsonSchema): JsonSchema {
  if (!isSchemaObject(schema)) return schema
  const out: JsonSchema = { ...schema }

  for (const key of UNSUPPORTED_KEYWORDS) delete out[key]

  // `oneOf` means the same thing as `anyOf` for a discriminated union — the
  // branches are mutually exclusive by construction — so the rename is lossless
  // for every schema zod can emit.
  if (Array.isArray(out.oneOf)) {
    const merged = [...(out.oneOf as unknown[])]
    if (Array.isArray(out.anyOf)) merged.push(...(out.anyOf as unknown[]))
    out.anyOf = merged
    delete out.oneOf
  }

  for (const key of SCHEMA_KEYWORDS) {
    const child = out[key]
    if (isSchemaObject(child)) out[key] = strictifyJsonSchema(child)
  }
  for (const key of SCHEMA_LIST_KEYWORDS) {
    const list = out[key]
    if (Array.isArray(list)) {
      out[key] = (list as unknown[]).map((s) => {
        return isSchemaObject(s) ? strictifyJsonSchema(s) : s
      })
    }
  }
  for (const key of SCHEMA_MAP_KEYWORDS) {
    const map = out[key]
    if (isSchemaObject(map)) {
      const next: JsonSchema = {}
      for (const [name, child] of Object.entries(map)) {
        next[name] = isSchemaObject(child) ? strictifyJsonSchema(child) : child
      }
      out[key] = next
    }
  }

  const properties = out.properties
  if (isSchemaObject(properties)) {
    const names = Object.keys(properties)
    const wasRequired = new Set(
      Array.isArray(out.required) ? (out.required as string[]) : [],
    )
    const next: JsonSchema = {}
    for (const [name, child] of Object.entries(properties)) {
      next[name] =
        isSchemaObject(child) && !wasRequired.has(name) ? withNull(child) : child
    }
    out.properties = next
    out.required = names
    out.additionalProperties = false
  }

  return out
}

/**
 * Undo the one widening {@link strictifyJsonSchema} performs on values: a `null`
 * the model sent for a property that the ORIGINAL schema left optional becomes
 * `undefined`, so the untouched zod schema still parses it.
 *
 * Walks the value against the ORIGINAL (pre-strictify) schema, so a field the
 * author genuinely declared nullable keeps its `null` — only the nulls this
 * dialect invented are removed. This is why `strictSchema` holds on to both
 * versions of the schema rather than just the strict one.
 */
export function stripDialectNulls(value: unknown, schema: JsonSchema): unknown {
  return walk(value, schema, schema)
}

function resolveRef(node: JsonSchema, root: JsonSchema): JsonSchema {
  const ref = node.$ref
  if (typeof ref !== 'string' || !ref.startsWith('#')) return node
  const path = ref.slice(1).split('/').filter(Boolean)
  let cursor: unknown = root
  for (const raw of path) {
    const seg = raw.replaceAll('~1', '/').replaceAll('~0', '~')
    if (!isSchemaObject(cursor)) return node
    cursor = cursor[seg]
  }
  return isSchemaObject(cursor) ? cursor : node
}

/**
 * The branch of a union that describes `value`, or the union node itself when
 * nothing narrows it. Good enough for the only job here — deciding which object
 * shape's `required` list applies — and deliberately shallow: a wrong guess
 * leaves a `null` in place, which zod then reports, rather than silently
 * dropping data.
 */
function selectBranch(
  value: unknown,
  branches: unknown[],
  root: JsonSchema,
): JsonSchema | undefined {
  const objects = branches
    .filter(isSchemaObject)
    .map((b) => resolveRef(b, root))
    .filter((b) => b.type !== 'null')
  if (objects.length === 1) return objects[0]
  if (!isSchemaObject(value)) return objects[0]
  // Prefer the branch whose declared properties the value actually carries —
  // the discriminated-union case, where every branch is an object.
  return objects.find((b) => {
    const props = b.properties
    if (!isSchemaObject(props)) return false
    return Object.keys(value).every((k) => Object.hasOwn(props, k))
  })
}

function walk(value: unknown, schema: JsonSchema, root: JsonSchema): unknown {
  if (!isSchemaObject(schema)) return value
  const node = resolveRef(schema, root)

  const union = Array.isArray(node.anyOf)
    ? node.anyOf
    : Array.isArray(node.oneOf)
      ? node.oneOf
      : undefined
  if (union) {
    const branch = selectBranch(value, union, root)
    return branch ? walk(value, branch, root) : value
  }

  if (Array.isArray(value)) {
    const items = node.items
    if (!isSchemaObject(items)) return value
    return value.map((v) => walk(v, items, root))
  }

  if (!isSchemaObject(value)) return value

  const properties = node.properties
  if (!isSchemaObject(properties)) return value
  const required = new Set(
    Array.isArray(node.required) ? (node.required as string[]) : [],
  )
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value)) {
    const child = properties[key]
    if (raw === null && !required.has(key) && isSchemaObject(child)) {
      // The property was optional before strictify made it required-and-nullable.
      // Drop the key entirely so `.optional()` and `.nullish()` both see the
      // absence the model meant.
      continue
    }
    out[key] = isSchemaObject(child) ? walk(raw, child, root) : raw
  }
  return out
}

/**
 * Convert a zod type to the strict JSON Schema dialect, without the validator
 * half. For a caller that needs the schema shape alone (an editor surface, a
 * hand-built `Schema`).
 *
 * `unrepresentable: 'any'` so a `.transform()` / `.pipe()` anywhere inside
 * degrades to `{}` instead of throwing — a schema that partially describes the
 * shape still constrains the model; an exception drops the call entirely.
 */
export function toStrictJsonSchema(
  zodType: z.ZodType,
  io: 'input' | 'output' = 'input',
): JsonSchema {
  return strictifyJsonSchema(rawJsonSchema(zodType, io))
}

function rawJsonSchema(zodType: z.ZodType, io: 'input' | 'output'): JsonSchema {
  return z.toJSONSchema(zodType, { io, unrepresentable: 'any' })
}

/**
 * Wrap a zod schema as an AI SDK {@link Schema} whose JSON Schema is strict-mode
 * valid while zod remains the validator.
 *
 * This is the shape to hand any provider-facing surface — `generateObject`'s
 * `schema`, a tool's `inputSchema` — in place of the bare zod type. What the
 * model is shown is the strict dialect; what the returned value is checked
 * against is the author's zod schema, unchanged.
 */
export function strictSchema<T>(
  zodType: z.ZodType<T>,
  io: 'input' | 'output' = 'input',
): Schema<T> {
  const original = rawJsonSchema(zodType, io)
  const strict = strictifyJsonSchema(original)
  return jsonSchema<T>(strict, {
    validate: (value: unknown) => {
      const parsed = zodType.safeParse(stripDialectNulls(value, original))
      return parsed.success
        ? { success: true, value: parsed.data }
        : { success: false, error: parsed.error }
    },
  })
}

/**
 * Rewrite an existing {@link Schema} (or bare zod type) so the JSON Schema a
 * provider receives is strict-dialect, while whatever validation it already
 * carried keeps running.
 *
 * The value-side counterpart matters as much as the schema-side one: the model
 * now answers a schema in which every property is required, so it sends `null`
 * for the ones it left blank. {@link stripDialectNulls} removes those before the
 * original validator sees them, using the PRE-strictify schema to tell an
 * invented null from one the author declared.
 */
export function strictifySchema<T>(schema: FlexibleSchema<T>): Schema<T> {
  const inner = asSchema(schema)
  const validate = inner.validate
  const original = Promise.resolve(inner.jsonSchema).then(
    (s) => s as JsonSchema,
  )
  return jsonSchema<T>(
    () => {
      return original.then((s) => strictifyJsonSchema(s) as ProviderJsonSchema)
    },
    {
      validate: validate
        ? async (value) => {
            return await validate(stripDialectNulls(value, await original))
          }
        : undefined,
    },
  )
}

/**
 * Strictify every tool's input schema in a tool set.
 *
 * Applied at the ONE point a tool set reaches a model rather than at each place
 * a tool is defined, so a tool authored anywhere — the host registry, a
 * synthesized sub-agent spawn tool, a playground mock — gets the same treatment
 * and none can be forgotten. A tool with no input schema is passed through.
 */
export function strictifyToolSet<T extends Record<string, Tool>>(tools: T): T {
  const out: Record<string, Tool> = {}
  for (const [name, t] of Object.entries(tools)) {
    out[name] = t.inputSchema
      ? { ...t, inputSchema: strictifySchema(t.inputSchema) }
      : t
  }
  return out as T
}
