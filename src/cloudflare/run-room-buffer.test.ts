import { describe, expect, test } from 'bun:test'

import {
  adoptTail,
  appendBounded,
  readTail,
  seqKey,
  type BufferStorage,
} from './run-room-buffer'

// A stand-in for DO storage with the one behavior that matters here: keys come
// back in lexicographic order, which is what the zero-padded sequence encoding
// relies on to mean "emit order".
function fakeStorage() {
  const rows = new Map<string, unknown>()
  const puts: string[] = []
  const storage: BufferStorage = {
    async put(key, value) {
      puts.push(key)
      rows.set(key, value)
    },
    async delete(keys) {
      let n = 0
      for (const k of keys) if (rows.delete(k)) n++
      return n
    },
    async list<T>(o: { prefix: string; limit: number; reverse: boolean }) {
      const matched = [...rows.entries()]
        .filter(([k]) => k.startsWith(o.prefix))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      const ordered = o.reverse ? matched.reverse() : matched
      return new Map(ordered.slice(0, o.limit)) as Map<string, T>
    },
  }
  return { storage, rows, puts }
}

describe('seqKey', () => {
  test('pads so lexicographic order matches numeric order across a decade', () => {
    expect(seqKey('log:', 9) < seqKey('log:', 10)).toBe(true)
    expect(seqKey('log:', 999) < seqKey('log:', 1000)).toBe(true)
  })
})

describe('appendBounded', () => {
  test('writes ONE key per entry, not the whole buffer', async () => {
    const { storage, rows, puts } = fakeStorage()
    const buffer: string[] = []
    for (let i = 0; i < 5; i++) {
      await appendBounded(storage, buffer, `e${i}`, 'log:', i, 10)
    }
    // Five appends, five keys — the regression this split exists to prevent is
    // one write whose SIZE grows with the buffer.
    expect(puts).toHaveLength(5)
    expect(new Set(puts).size).toBe(5)
    expect(rows.size).toBe(5)
    expect(buffer).toEqual(['e0', 'e1', 'e2', 'e3', 'e4'])
  })

  test('trims the oldest key once past the bound, leaving exactly `max`', async () => {
    const { storage, rows } = fakeStorage()
    const buffer: string[] = []
    for (let i = 0; i < 6; i++) {
      await appendBounded(storage, buffer, `e${i}`, 'log:', i, 3)
    }
    expect(buffer).toEqual(['e3', 'e4', 'e5'])
    expect(rows.size).toBe(3)
    expect([...rows.keys()].sort()).toEqual([
      seqKey('log:', 3),
      seqKey('log:', 4),
      seqKey('log:', 5),
    ])
  })

  test('a trimmed buffer still round-trips through readTail in emit order', async () => {
    const { storage } = fakeStorage()
    const buffer: string[] = []
    for (let i = 0; i < 12; i++) {
      await appendBounded(storage, buffer, `e${i}`, 'log:', i, 4)
    }
    const tail = await readTail<string>(storage, 'log:', 4)
    expect(tail.values).toEqual(['e8', 'e9', 'e10', 'e11'])
    // Next sequence continues past what's on disk, so a resumed room doesn't
    // reuse a key it already trimmed.
    expect(tail.nextSeq).toBe(12)
  })

  test('two prefixes in one storage do not see each other', async () => {
    const { storage } = fakeStorage()
    const logs: string[] = []
    const progress: string[] = []
    await appendBounded(storage, logs, 'L0', 'log:', 0, 10)
    await appendBounded(storage, progress, 'P0', 'prog:', 0, 10)
    await appendBounded(storage, progress, 'P1', 'prog:', 1, 10)
    expect((await readTail<string>(storage, 'log:', 10)).values).toEqual(['L0'])
    expect((await readTail<string>(storage, 'prog:', 10)).values).toEqual([
      'P0',
      'P1',
    ])
  })
})

describe('readTail', () => {
  test('an empty prefix starts the sequence at zero', async () => {
    const { storage } = fakeStorage()
    expect(await readTail<string>(storage, 'log:', 10)).toEqual({
      values: [],
      nextSeq: 0,
    })
  })
})

describe('adoptTail', () => {
  test('prefers per-key entries when any exist', () => {
    const fromKeys = { values: ['a'], nextSeq: 7 }
    expect(adoptTail(fromKeys, ['legacy'], 10)).toBe(fromKeys)
  })

  test('falls back to a pre-split blob array, seeding the cursor past it', () => {
    const adopted = adoptTail({ values: [], nextSeq: 0 }, ['a', 'b', 'c'], 10)
    expect(adopted).toEqual({ values: ['a', 'b', 'c'], nextSeq: 3 })
  })

  test('an over-long legacy array is cut to the bound, and the next trim stays in range', async () => {
    const { storage, rows } = fakeStorage()
    const adopted = adoptTail({ values: [], nextSeq: 0 }, ['a', 'b', 'c'], 2)
    expect(adopted).toEqual({ values: ['b', 'c'], nextSeq: 2 })
    // The regression guarded here: seeding nextSeq at 0 with a full buffer made
    // the first trim compute a NEGATIVE sequence and delete a nonexistent key,
    // leaking the real one forever.
    await appendBounded(storage, adopted.values, 'd', 'log:', adopted.nextSeq, 2)
    expect(adopted.values).toEqual(['c', 'd'])
    for (const k of rows.keys()) expect(k).not.toContain('-')
  })
})
