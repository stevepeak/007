// The built-in output JSON Schemas for the non-`object` agent output kinds, plus
// the resolver that maps any output contract to its concrete JSON Schema.

import type { JsonSchema } from './agent-output-scan'

// A stable JSON Schema for the YES/NO output kind — a boolean `answer` plus a
// short `reason` explaining the decision (surfaced for routing/gate audits).
export const BOOLEAN_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    answer: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['answer', 'reason'],
  additionalProperties: false,
}

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
