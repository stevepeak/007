import { describe, expect, test } from 'bun:test'

import { asRecord, isRecord } from './guards'

describe('isRecord / asRecord', () => {
  test('only non-null, non-array objects are records', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord('x')).toBe(false)
    expect(asRecord({ a: 1 })).toEqual({ a: 1 })
    expect(asRecord([1])).toBeUndefined()
  })
})
