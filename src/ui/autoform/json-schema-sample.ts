import type { JsonSchema } from '../../server/protocol'

import { asObject, isPlainObject } from './json-schema-helpers'

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
