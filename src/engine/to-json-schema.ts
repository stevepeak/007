import { z } from 'zod'

import type { JsonSchema } from './agent-output'

// The one Zod → JSON Schema conversion for describing a schema on the wire —
// tool inputs and outputs, trigger payloads, output contracts.
//
// `io` names the side: an input schema is described as what the schema
// *accepts* (`'input'`), an output schema as what it *emits* (`'output'`). The
// two differ wherever a `.transform()` / `.pipe()` / `.default()` is involved.
// `unrepresentable: 'any'` is essential: without it a single `.transform()`
// anywhere in the tree makes the whole conversion THROW, so the shape would
// vanish entirely; the field just degrades to `{}` (any) instead. Anything
// still unconvertible falls back to "no schema" rather than failing the caller.
export function toJsonSchema(args: {
  schema: z.ZodType | undefined
  io: 'input' | 'output'
}): JsonSchema | undefined {
  if (!args.schema) return undefined
  try {
    return z.toJSONSchema(args.schema, { io: args.io, unrepresentable: 'any' })
  } catch {
    return undefined
  }
}
