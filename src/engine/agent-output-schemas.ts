// The built-in output JSON Schemas for the non-`object` agent output kinds, plus
// the resolver that maps any output contract to its concrete JSON Schema.

import { compileZodSource } from './agent-output-compiler'
import type { JsonSchema } from './agent-output-scan'

// The YES/NO output kind, authored as Zod source and compiled once at load.
//
// The source is the single source of truth: the editor SHOWS this string
// read-only and the engine RUNS the schema compiled from it, so what an author
// reads is literally the contract, with no decompiler round-trip to drift
// through. The `.describe()` text is the agent's only instruction for each
// field, which is why the 0.0–1.0 range lives there — the compiler's subset has
// no numeric bounds, and a bound the model never sees wouldn't help anyway.
//
// `confidence` and `feedback` exist so a gate can be more than a coin flip: a
// low score with a concrete "I'd need the signed copy of the lease" is the
// difference between a decision you can route on and one you should escalate.
export const BOOLEAN_OUTPUT_SOURCE = `z.object({
  answer: z.boolean().describe("The decision: true for yes, false for no."),
  confidence: z.number().describe("How sure you are of the answer, as a decimal from 0.0 (a pure guess) to 1.0 (certain) — e.g. 0.25, 0.8, 0.95."),
  reason: z.string().describe("A short justification for the decision."),
  feedback: z.string().nullish().describe("What information or access would have raised your confidence. Null if nothing would."),
})`

// Compiled at module load. The source is a fixed literal covered by a test, so
// a failure here is a bug in this file, not bad input — hence the throw rather
// than a silent fallback that would ship a wrong contract to every YES/NO agent.
export const BOOLEAN_OUTPUT_SCHEMA: JsonSchema = (() => {
  const compiled = compileZodSource(BOOLEAN_OUTPUT_SOURCE)
  if (!compiled.ok) {
    throw new Error(`BOOLEAN_OUTPUT_SOURCE does not compile: ${compiled.error}`)
  }
  return compiled.schema
})()

// The JSON Schema for the plain-text output kind — the agent's final answer
// under a single `text` field. Mirrors the `{ text }` shape agent nodes emit.
export const TEXT_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
}

// The concrete output shape an agent produces, as JSON Schema — so downstream
// nodes can see (and map into) an agent's fields regardless of output kind.
// `AgentOutput` is typed structurally to avoid a runtime import cycle with
// `graph.ts` (which defines it and does not import this module).
export function agentOutputJsonSchema(output: {
  kind: 'text' | 'boolean' | 'object'
  schema?: JsonSchema
}): JsonSchema {
  if (output.kind === 'text') return TEXT_OUTPUT_SCHEMA
  if (output.kind === 'boolean') return BOOLEAN_OUTPUT_SCHEMA
  return output.schema ?? { type: 'object' }
}
