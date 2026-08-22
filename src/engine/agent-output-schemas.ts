// The built-in output JSON Schemas for the non-`object` agent output kinds, plus
// the resolver that maps any output contract to its concrete JSON Schema.

import type { JsonSchema } from './agent-output-scan'

// A stable JSON Schema for the YES/NO output kind — the decision itself, how
// sure the agent is of it, why, and what would have made it surer. `confidence`
// and `feedback` exist so a gate can be more than a coin flip: a low score with
// a concrete "I'd need the signed copy of the lease" is the difference between
// a decision you can route on and one you should escalate. The descriptions are
// the agent's only instructions for these fields, so they carry the contract
// (including the 0–1 range, which JSON Schema bounds can't express through the
// editor's Zod subset).
export const BOOLEAN_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    answer: {
      type: 'boolean',
      description: 'The decision: true for yes, false for no.',
    },
    confidence: {
      type: 'number',
      description:
        'How sure you are of the answer, from 0 (a guess) to 1 (certain).',
    },
    reason: {
      type: 'string',
      description: 'A short justification for the decision.',
    },
    feedback: {
      type: 'string',
      description:
        'What information or access would have raised your confidence. Empty if nothing would.',
    },
  },
  required: ['answer', 'confidence', 'reason', 'feedback'],
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
