import { asSchema, tool, type Tool } from 'ai'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import type { JsonSchema } from './agent-output-scan'
import {
  strictifyJsonSchema,
  strictifyToolSet,
  strictSchema,
  stripDialectNulls,
  toStrictJsonSchema,
} from './strict-schema'

// Walk every node of a schema and hand each one to `visit`, so a test can assert
// a property holds at EVERY depth rather than only at the root — which is where
// the original bug hid (a `minItems` three levels down inside a union branch).
function eachNode(schema: unknown, visit: (node: JsonSchema) => void): void {
  if (Array.isArray(schema)) {
    for (const s of schema) eachNode(s, visit)
    return
  }
  if (typeof schema !== 'object' || schema === null) return
  const node = schema as JsonSchema
  visit(node)
  for (const value of Object.values(node)) eachNode(value, visit)
}

const UNSUPPORTED = [
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'pattern',
  'format',
  'multipleOf',
  'uniqueItems',
  'oneOf',
]

describe('strictifyJsonSchema', () => {
  test('a discriminated union + bounds round-trips to the strict dialect', () => {
    // The schema shape that failed on all three providers: a discriminated union
    // (→ `oneOf`), array/string bounds (→ `minItems` / `minLength`), and an
    // optional property (→ omitted from `required`).
    const source = z.object({
      title: z.string().min(1).max(200),
      tags: z.array(z.string()).min(1),
      note: z.string().optional(),
      block: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('heading'), level: z.number().min(1) }),
        z.object({ kind: z.literal('paragraph'), text: z.string() }),
      ]),
    })

    const strict = toStrictJsonSchema(source)

    eachNode(strict, (node) => {
      for (const keyword of UNSUPPORTED) {
        expect(node[keyword]).toBeUndefined()
      }
      // Every object that declares properties requires all of them and closes.
      if (node.properties && typeof node.properties === 'object') {
        expect(node.required).toEqual(
          Object.keys(node.properties as Record<string, unknown>),
        )
        expect(node.additionalProperties).toBe(false)
      }
    })

    // The union survived the rename rather than being dropped.
    const block = (strict.properties as Record<string, JsonSchema>).block
    expect(Array.isArray(block.anyOf)).toBe(true)
    expect((block.anyOf as unknown[]).length).toBe(2)
  })

  test('an optional property becomes required and nullable', () => {
    const strict = toStrictJsonSchema(
      z.object({ id: z.string(), note: z.string().optional() }),
    )
    const props = strict.properties as Record<string, JsonSchema>
    expect(strict.required).toEqual(['id', 'note'])
    expect(props.id.type).toBe('string')
    expect(props.note.type).toEqual(['string', 'null'])
  })

  test('a `.nullish()` property is not double-nulled', () => {
    const strict = toStrictJsonSchema(
      z.object({ note: z.string().nullish().describe('Optional note.') }),
    )
    const note = (strict.properties as Record<string, JsonSchema>).note
    // Zod already prints a nullable as `type: [t, 'null']`; the widening must
    // leave that alone rather than nesting a second null around it.
    expect(note.type).toEqual(['string', 'null'])
    expect(note.anyOf).toBeUndefined()
    // The description stays where the model reads it.
    expect(note.description).toBe('Optional note.')
  })

  test('an open record keeps its permissive shape', () => {
    // No `properties` to require, and strict mode cannot express an open map —
    // closing it would turn "any keys" into "no keys".
    const strict = strictifyJsonSchema({
      type: 'object',
      additionalProperties: { type: 'string' },
    })
    expect(strict.required).toBeUndefined()
    expect(strict.additionalProperties).toEqual({ type: 'string' })
  })

  test('nested `$defs` are strictified too', () => {
    const strict = strictifyJsonSchema({
      type: 'object',
      properties: { a: { $ref: '#/$defs/Inner' } },
      required: ['a'],
      $defs: {
        Inner: {
          type: 'object',
          properties: { n: { type: 'number', minimum: 1 } },
          required: [],
        },
      },
    })
    const inner = (strict.$defs as Record<string, JsonSchema>).Inner
    const n = (inner.properties as Record<string, JsonSchema>).n
    expect(n.minimum).toBeUndefined()
    expect(inner.required).toEqual(['n'])
  })
})

describe('stripDialectNulls', () => {
  test('a null for a formerly-optional field is dropped', () => {
    const original = {
      type: 'object',
      properties: { id: { type: 'string' }, note: { type: 'string' } },
      required: ['id'],
    }
    expect(stripDialectNulls({ id: 'x', note: null }, original)).toEqual({
      id: 'x',
    })
  })

  test('a null the author declared is kept', () => {
    const original = {
      type: 'object',
      properties: {
        note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['note'],
    }
    expect(stripDialectNulls({ note: null }, original)).toEqual({ note: null })
  })

  test('nulls inside arrays and nested objects are dropped', () => {
    const original = {
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          items: {
            type: 'object',
            properties: { a: { type: 'string' }, b: { type: 'string' } },
            required: ['a'],
          },
        },
      },
      required: ['rows'],
    }
    expect(
      stripDialectNulls(
        {
          rows: [
            { a: '1', b: null },
            { a: '2', b: 'x' },
          ],
        },
        original,
      ),
    ).toEqual({ rows: [{ a: '1' }, { a: '2', b: 'x' }] })
  })
})

describe('strictSchema', () => {
  test('the model sees the strict dialect and zod still validates', async () => {
    const source = z.object({
      title: z.string().min(3),
      note: z.string().optional(),
    })
    const schema = strictSchema(source)

    const emitted = (await schema.jsonSchema) as JsonSchema
    expect(emitted.required).toEqual(['title', 'note'])
    expect(
      (emitted.properties as Record<string, JsonSchema>).title.minLength,
    ).toBeUndefined()

    // A provider answering the strict schema sends `null` for the absent
    // optional; zod must still accept it.
    const ok = await schema.validate!({ title: 'Demand', note: null })
    expect(ok.success).toBe(true)
    expect(ok.success && ok.value).toEqual({ title: 'Demand' })

    // The dropped `minLength` is still enforced by zod at runtime.
    const bad = await schema.validate!({ title: 'no', note: null })
    expect(bad.success).toBe(false)
  })
})

describe('strictifyToolSet', () => {
  test("a tool's input schema reaches the model strict, and still validates", async () => {
    const tools = {
      search_documents: tool({
        description: 'Search the corpus.',
        inputSchema: z.object({
          query: z.string().min(1).describe('What to search for.'),
          limit: z.number().optional().describe('How many results.'),
        }),
        execute: () => Promise.resolve({ hits: [] }),
      }),
    }

    const strict = strictifyToolSet(tools)
    const schema = asSchema(strict.search_documents.inputSchema)
    const emitted = (await schema.jsonSchema) as JsonSchema

    expect(emitted.required).toEqual(['query', 'limit'])
    expect(emitted.additionalProperties).toBe(false)
    const props = emitted.properties as Record<string, JsonSchema>
    expect(props.query.minLength).toBeUndefined()
    expect(props.limit.type).toEqual(['number', 'null'])
    // Descriptions are prompt — they must survive the transform.
    expect(props.query.description).toBe('What to search for.')

    // The model answers the strict schema with an explicit null for the field it
    // left blank; the tool's own zod schema must still accept the call.
    const ok = await schema.validate!({ query: 'lease', limit: null })
    expect(ok.success).toBe(true)
    expect(ok.success && ok.value).toEqual({ query: 'lease' })
  })

  test('a tool with no input schema is passed through untouched', () => {
    // Defensive: the `ai` types require `inputSchema`, but a tool can reach the
    // engine from a host's own construction, and rewriting a schema that isn't
    // there must not invent one.
    const ping = { description: 'Ping.' } as unknown as Tool
    expect(strictifyToolSet({ ping }).ping).toBe(ping)
  })
})
