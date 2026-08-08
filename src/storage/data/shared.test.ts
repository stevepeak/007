import { describe, expect, test } from 'bun:test'

import { chunk, clampLimit, ID_CHUNK_SIZE, selectChunked } from './shared'

describe('chunk', () => {
  test('returns nothing for an empty list', () => {
    expect(chunk([])).toEqual([])
  })

  test('leaves a list inside the budget in one piece', () => {
    const ids = Array.from({ length: ID_CHUNK_SIZE }, (_, i) => i)
    expect(chunk(ids)).toEqual([ids])
  })

  test('splits an exact multiple evenly', () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ])
  })

  test('carries the remainder in a final short chunk', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  test('never emits a chunk over the default budget', () => {
    const ids = Array.from({ length: 250 }, (_, i) => i)
    const chunks = chunk(ids)
    expect(chunks.length).toBe(3)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(ID_CHUNK_SIZE)
    expect(chunks.flat()).toEqual(ids)
  })
})

describe('selectChunked', () => {
  test('short-circuits an empty list without querying', async () => {
    let calls = 0
    const rows = await selectChunked([], async (ids) => {
      calls++
      return ids
    })
    expect(rows).toEqual([])
    expect(calls).toBe(0)
  })

  test('issues a single query when the list fits the budget', async () => {
    const seen: number[][] = []
    const rows = await selectChunked(
      [1, 2, 3],
      async (ids) => {
        seen.push(ids)
        return ids
      },
      2,
    )
    // 3 ids at size 2 is two chunks; at the default size it would be one.
    expect(seen).toEqual([[1, 2], [3]])
    expect(rows).toEqual([1, 2, 3])

    const single: number[][] = []
    await selectChunked([1, 2, 3], async (ids) => {
      single.push(ids)
      return ids
    })
    expect(single).toEqual([[1, 2, 3]])
  })

  test('concatenates chunk results in chunk order', async () => {
    const ids = Array.from({ length: 5 }, (_, i) => i)
    const rows = await selectChunked(ids, async (c) => c.map((i) => `row-${i}`), 2)
    expect(rows).toEqual(['row-0', 'row-1', 'row-2', 'row-3', 'row-4'])
  })

  test('passes a plain array even when handed a readonly list', async () => {
    const ids: readonly string[] = ['a', 'b']
    const rows = await selectChunked(ids, async (c) => {
      expect(Array.isArray(c)).toBe(true)
      return c
    })
    expect(rows).toEqual(['a', 'b'])
  })
})

describe('clampLimit', () => {
  test('floors at 1 and ceilings at max', () => {
    expect(clampLimit(0, { fallback: 50, max: 200 })).toBe(1)
    expect(clampLimit(999, { fallback: 50, max: 200 })).toBe(200)
    expect(clampLimit(undefined, { fallback: 50, max: 200 })).toBe(50)
  })
})
