import { describe, expect, test } from 'bun:test'

import {
  compileZodSource,
  formatZodSource,
  zodSourceFromJsonSchema,
  type JsonSchema,
} from './agent-output'

describe('compileZodSource — extended grammar', () => {
  test('.nullable() compiles to an anyOf-with-null union', () => {
    const r = compileZodSource('z.object({ a: z.string().nullable() })')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.schema.properties).toMatchObject({
      a: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    })
  })

  test('.int() narrows z.number() to integer', () => {
    const r = compileZodSource('z.object({ n: z.number().int() })')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect((r.schema.properties as Record<string, JsonSchema>).n).toEqual({
      type: 'integer',
    })
  })

  test('.nullable().describe() hoists the description onto the outer node', () => {
    const r = compileZodSource(
      'z.object({ n: z.number().int().nullable().describe("idx or null") })',
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect((r.schema.properties as Record<string, JsonSchema>).n).toEqual({
      anyOf: [{ type: 'integer' }, { type: 'null' }],
      description: 'idx or null',
    })
  })

  test('.int() on a non-number is rejected', () => {
    const r = compileZodSource('z.object({ a: z.string().int() })')
    expect(r.ok).toBe(false)
  })
})

describe('compileZodSource — comments', () => {
  test('ignores //, #, and block comments', () => {
    const r = compileZodSource(`
      // a leading note
      z.object({
        a: z.string(), # the name
        /* the flag */ b: z.boolean(),
      })
    `)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(Object.keys(r.schema.properties as object)).toEqual(['a', 'b'])
  })

  test('an unterminated block comment is a hard error', () => {
    const r = compileZodSource('z.object({ a: z.string() }) /* oops')
    expect(r.ok).toBe(false)
  })
})

describe('formatZodSource', () => {
  test('reflows a one-line object into the house style', () => {
    const out = formatZodSource('z.object({ a: z.string(), b: z.number() })')
    expect(out).toBe('z.object({\n  a: z.string(),\n  b: z.number(),\n})')
  })

  test('keeps arrays and enums inline while expanding the object', () => {
    const out = formatZodSource(
      'z.object({ tags: z.array(z.string()), size: z.enum(["s","m","l"]) })',
    )
    expect(out).toBe(
      'z.object({\n  tags: z.array(z.string()),\n  size: z.enum(["s", "m", "l"]),\n})',
    )
  })

  test('preserves leading and trailing comments', () => {
    const out = formatZodSource(
      'z.object({\n// which name\na: z.string(), # inline note\n})',
    )
    expect(out).toBe(
      'z.object({\n  // which name\n  a: z.string(), // inline note\n})',
    )
  })

  test('output re-parses to the same schema', () => {
    const src = 'z.object({ a: z.string(),   b:z.boolean() /* x */ })'
    const before = compileZodSource(src)
    const after = compileZodSource(formatZodSource(src))
    expect(before.ok && after.ok).toBe(true)
    if (!before.ok || !after.ok) return
    expect(after.schema).toEqual(before.schema)
  })

  test('leaves un-lexable input untouched', () => {
    expect(formatZodSource('z.object({ a: 123 })')).toBe(
      'z.object({ a: 123 })',
    )
  })
})

describe('zodSourceFromJsonSchema — round-trips through the compiler', () => {
  const cases: { name: string; source: string }[] = [
    { name: 'scalars', source: 'z.object({\n  a: z.string(),\n})' },
    {
      name: 'nullable + describe',
      source:
        'z.object({\n  price: z.number().nullable().describe("Menu price. Null if none."),\n})',
    },
    {
      name: 'integer nullable',
      source:
        'z.object({\n  idx: z.number().int().nullable().describe("0-based, or null"),\n})',
    },
    {
      name: 'array of nested objects',
      source:
        'z.object({\n  items: z.array(z.object({\n    name: z.string(),\n    ok: z.boolean(),\n  })).describe("all items"),\n})',
    },
    {
      name: 'enum',
      source: 'z.object({\n  size: z.enum(["s", "m", "l"]),\n})',
    },
  ]

  for (const c of cases) {
    test(`${c.name}: schema → source → schema is stable`, () => {
      const first = compileZodSource(c.source)
      expect(first.ok).toBe(true)
      if (!first.ok) return
      const regenerated = zodSourceFromJsonSchema(first.schema)
      const second = compileZodSource(regenerated)
      expect(second.ok).toBe(true)
      if (!second.ok) return
      expect(second.schema).toEqual(first.schema)
    })
  }

  test('empty or missing schema yields no source (placeholder shows instead)', () => {
    expect(zodSourceFromJsonSchema(undefined)).toBe('')
    expect(
      zodSourceFromJsonSchema({ type: 'object', properties: {} }),
    ).toBe('')
  })
})
