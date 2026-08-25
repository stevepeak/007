import { describe, expect, test } from 'bun:test'

import {
  encodedByteLength,
  hasBlobRef,
  isBlobRef,
  makeBlobRef,
  rehydrateBlobRefs,
  spillLargeLeaves,
  WF_BLOB_JSON_CONTENT_TYPE,
  type BlobWrite,
  type WfBlobRef,
} from './blob-ref'

// A stand-in for the host's blob store: keyed by the path the walk reports, so
// a test can assert WHICH leaf spilled, not just that something did.
function fakeStore() {
  const objects = new Map<string, string>()
  const write: BlobWrite = async ({ text, path }) => {
    const key = `k:${path}`
    objects.set(key, text)
    return { key, storage: 'r2' }
  }
  const resolve = async (ref: WfBlobRef): Promise<string> => {
    const hit = objects.get(ref.key)
    if (hit === undefined) throw new Error(`missing ${ref.key}`)
    return hit
  }
  return { objects, write, resolve }
}

function OPTS(write: BlobWrite) {
  return { thresholdBytes: 100, previewChars: 10, write }
}

function big(n = 200): string {
  return 'x'.repeat(n)
}

describe('spillLargeLeaves', () => {
  test('leaves a small value untouched', async () => {
    const { write, objects } = fakeStore()
    const value = { text: 'short', n: 1 }
    expect(await spillLargeLeaves(value, OPTS(write))).toEqual(value)
    expect(objects.size).toBe(0)
  })

  test('spills an oversized string leaf and keeps the shape around it', async () => {
    const { write, objects } = fakeStore()
    const out = (await spillLargeLeaves(
      { text: big(), mode: 'ocr', meta: { pages: 3 } },
      OPTS(write),
    )) as { text: WfBlobRef; mode: string; meta: { pages: number } }

    // The whole point: siblings survive, so `ref(node, 'mode')` still resolves.
    expect(out.mode).toBe('ocr')
    expect(out.meta).toEqual({ pages: 3 })
    expect(isBlobRef(out.text)).toBe(true)
    expect(out.text.bytes).toBe(200)
    expect(out.text.preview).toBe('x'.repeat(10))
    expect(out.text.contentType).toBe('text/plain')
    expect(objects.get('k:text')).toBe(big())
  })

  test('spills nested leaves and names each by its path', async () => {
    const { write, objects } = fakeStore()
    await spillLargeLeaves(
      { items: [{ body: big() }, { body: 'small' }, { body: big() }] },
      OPTS(write),
    )
    expect([...objects.keys()].sort()).toEqual([
      'k:items.0.body',
      'k:items.2.body',
    ])
  })

  test('a bare oversized string spills to the empty path', async () => {
    const { write, objects } = fakeStore()
    const out = await spillLargeLeaves(big(), OPTS(write))
    expect(isBlobRef(out)).toBe(true)
    expect(objects.has('k:')).toBe(true)
  })

  test('an existing pointer is not re-spilled', async () => {
    const { write, objects } = fakeStore()
    const ref = makeBlobRef({ key: 'already/there', bytes: 9_000 })
    expect(await spillLargeLeaves({ text: ref }, OPTS(write))).toEqual({
      text: ref,
    })
    expect(objects.size).toBe(0)
  })

  test('a big value made of many small leaves is left alone — spilling cannot help', async () => {
    const { write, objects } = fakeStore()
    const wide = { items: Array.from({ length: 500 }, (_, i) => `item ${i}`) }
    expect(await spillLargeLeaves(wide, OPTS(write))).toEqual(wide)
    expect(objects.size).toBe(0)
    // The caller is the one that has to notice and complain; see
    // `assertFitsBoundary` in the dispatcher.
    expect(encodedByteLength(wide)!).toBeGreaterThan(100)
  })
})

describe('spill → rehydrate round trip', () => {
  test('a spilled string comes back as the same string', async () => {
    const { write, resolve } = fakeStore()
    const spilled = await spillLargeLeaves({ text: big() }, OPTS(write))
    expect(await rehydrateBlobRefs(spilled, resolve)).toEqual({ text: big() })
  })

  test('rehydrating reaches pointers nested in arrays', async () => {
    const { write, resolve } = fakeStore()
    const input = { items: [{ body: big() }, { body: 'small' }] }
    const spilled = await spillLargeLeaves(input, OPTS(write))
    expect(await rehydrateBlobRefs(spilled, resolve)).toEqual(input)
  })

  test('a JSON-tagged ref parses back to its value, not to the JSON string', async () => {
    const payload = { rows: [1, 2, 3] }
    const ref = makeBlobRef({
      key: 'j',
      contentType: WF_BLOB_JSON_CONTENT_TYPE,
    })
    const out = await rehydrateBlobRefs(ref, async () => JSON.stringify(payload))
    expect(out).toEqual(payload)
  })

  test('a JSON-tagged ref that does not parse fails loudly, naming the key', async () => {
    const ref = makeBlobRef({
      key: 'corrupt-key',
      contentType: WF_BLOB_JSON_CONTENT_TYPE,
    })
    await expect(
      rehydrateBlobRefs(ref, async () => 'not json'),
    ).rejects.toThrow(/corrupt-key/)
  })
})

describe('encodedByteLength', () => {
  test('measures the JSON encoding in UTF-8 bytes, not characters', () => {
    // 3 bytes per '€', plus the two quotes.
    expect(encodedByteLength('€€')).toBe(8)
  })

  test('undefined encodes as empty rather than reading as a failure', () => {
    expect(encodedByteLength(undefined)).toBe(0)
  })

  test('an unencodable value reports undefined instead of throwing', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(encodedByteLength(cyclic)).toBeUndefined()
  })
})

describe('hasBlobRef', () => {
  test('finds a pointer nested in objects and arrays', () => {
    const ref = makeBlobRef({ key: 'k' })
    expect(hasBlobRef({ a: [{ b: ref }] })).toBe(true)
  })

  test('is false for a value with nothing spilled — the common answer', () => {
    expect(hasBlobRef({ text: 'hello', items: [1, 2, { n: null }] })).toBe(false)
  })

  test('is false for scalars and nullish', () => {
    expect(hasBlobRef(undefined)).toBe(false)
    expect(hasBlobRef(null)).toBe(false)
    expect(hasBlobRef(42)).toBe(false)
  })
})
