import { describe, expect, test } from 'bun:test'

import { schemaPathOptions } from './fields'

// The check editor's field pickers are derived entirely from a schema — an
// agent's output contract, or a tool's Zod-derived input schema. What matters
// here is the `values` half: it decides whether the expected value is a picker
// of the field's declared answers or a free-text box, and a field whose closed
// set goes unnoticed is exactly the check an author fills in by hand and
// misspells.

describe('schemaPathOptions', () => {
  test('returns null when there is no usable object schema', () => {
    expect(schemaPathOptions(null)).toBeNull()
    expect(schemaPathOptions(undefined)).toBeNull()
    expect(schemaPathOptions({ type: 'string' })).toBeNull()
    expect(schemaPathOptions({ type: 'object', properties: {} })).toBeNull()
  })

  test('offers an enum field its declared members', () => {
    const options = schemaPathOptions({
      type: 'object',
      properties: {
        decision: {
          type: 'string',
          enum: ['CLEAR', 'FLAG', 'UNCERTAIN', 'ERROR'],
          description: 'E2 disposition.',
        },
      },
    })
    expect(options).toEqual([
      {
        value: 'decision',
        label: 'decision',
        type: 'string',
        description: 'E2 disposition.',
        values: ['CLEAR', 'FLAG', 'UNCERTAIN', 'ERROR'],
        valueMatch: 'equals',
      },
    ])
  })

  test('offers a boolean field its two values, typed', () => {
    const options = schemaPathOptions({
      type: 'object',
      properties: { answer: { type: 'boolean' } },
    })
    // Typed, not stringified: the graded comparison is deep equality, where the
    // string "true" is not the boolean the run produced.
    expect(options?.[0].values).toEqual([true, false])
  })

  test('leaves an open-ended field without a value list', () => {
    const options = schemaPathOptions({
      type: 'object',
      properties: {
        reason: { type: 'string' },
        confidence: { type: 'number' },
      },
    })
    expect(options?.map((o) => o.values)).toEqual([undefined, undefined])
  })

  test('sees through a nullable wrapper to the values underneath', () => {
    // `.nullish()` is the authored spelling for an optional field, and it
    // reaches here as a union with null in either JSON Schema dialect.
    const options = schemaPathOptions({
      type: 'object',
      properties: {
        tier: {
          anyOf: [{ type: 'string', enum: ['a', 'b'] }, { type: 'null' }],
        },
        flagged: { type: ['boolean', 'null'] },
      },
    })
    expect(options?.[0].values).toEqual(['a', 'b'])
    expect(options?.[1].values).toEqual([true, false])
  })

  test('offers a list of enums its element values, matched by membership', () => {
    const options = schemaPathOptions({
      type: 'object',
      properties: {
        reason_codes: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['NO_CONFLICT_INDICATOR', 'UNCERTAIN'],
          },
        },
      },
    })
    // `contains` is array membership; `equals` would compare the whole list to
    // one member and never hold.
    expect(options?.[0].values).toEqual(['NO_CONFLICT_INDICATOR', 'UNCERTAIN'])
    expect(options?.[0].valueMatch).toBe('contains')
  })

  test('leaves an open-ended list without a value list', () => {
    const options = schemaPathOptions({
      type: 'object',
      properties: { parties: { type: 'array', items: { type: 'string' } } },
    })
    expect(options?.[0].values).toBeUndefined()
  })

  test('ignores an empty enum rather than offering an empty picker', () => {
    const options = schemaPathOptions({
      type: 'object',
      properties: { tier: { type: 'string', enum: [] } },
    })
    expect(options?.[0].values).toBeUndefined()
  })

  test('flattens a nested object into its dotted paths', () => {
    const options = schemaPathOptions({
      type: 'object',
      properties: {
        lock: { type: 'boolean' },
        review: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['open', 'closed'] },
            note: { type: 'string' },
          },
        },
      },
    })
    // The object itself stays assertable alongside the fields inside it — the
    // graded path walk takes either.
    expect(options?.map((o) => o.value)).toEqual([
      'lock',
      'review',
      'review.status',
      'review.note',
    ])
    expect(options?.find((o) => o.value === 'review.status')?.values).toEqual([
      'open',
      'closed',
    ])
  })

  test('stops descending at an array, whose elements have no author-time index', () => {
    const options = schemaPathOptions({
      type: 'object',
      properties: {
        parties: {
          type: 'array',
          items: { type: 'object', properties: { name: { type: 'string' } } },
        },
      },
    })
    expect(options?.map((o) => o.value)).toEqual(['parties'])
  })

  test('stops descending past a few levels rather than flattening a deep schema', () => {
    const leaf: Record<string, unknown> = {
      type: 'object',
      properties: { d: { type: 'string' } },
    }
    const options = schemaPathOptions({
      type: 'object',
      properties: {
        a: { type: 'object', properties: { b: { type: 'object', properties: { c: leaf } } } },
      },
    })
    expect(options?.map((o) => o.value)).toEqual(['a', 'a.b', 'a.b.c'])
  })
})
