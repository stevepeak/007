import { describe, expect, test } from 'bun:test'

import {
  isBlobRef,
  makeBlobRef,
  rehydrateBlobRefs,
  WF_BLOB_REF_TAG,
} from './blob-ref'

describe('blob-ref helpers', () => {
  test('makeBlobRef stamps the discriminant tag', () => {
    const ref = makeBlobRef({ key: 'extracted/doc.txt', bytes: 10 })
    expect(ref[WF_BLOB_REF_TAG]).toBe(true)
    expect(ref.key).toBe('extracted/doc.txt')
    expect(isBlobRef(ref)).toBe(true)
  })

  test('isBlobRef rejects look-alikes and non-objects', () => {
    expect(isBlobRef({ key: 'x' })).toBe(false)
    expect(isBlobRef({ [WF_BLOB_REF_TAG]: true })).toBe(false) // no key
    expect(isBlobRef('extracted/doc.txt')).toBe(false)
    expect(isBlobRef(null)).toBe(false)
    expect(isBlobRef(undefined)).toBe(false)
  })

  test('rehydrateBlobRefs resolves a bare ref to its text', async () => {
    const ref = makeBlobRef({ key: 'k1' })
    const out = await rehydrateBlobRefs(ref, async (r) => `text:${r.key}`)
    expect(out).toBe('text:k1')
  })

  test('rehydrateBlobRefs replaces refs nested in objects/arrays', async () => {
    const value = {
      text: makeBlobRef({ key: 'k1' }),
      nested: { deep: makeBlobRef({ key: 'k2' }) },
      list: [makeBlobRef({ key: 'k3' }), 'plain'],
      untouched: 42,
    }
    const out = await rehydrateBlobRefs(value, async (r) => `T(${r.key})`)
    expect(out).toEqual({
      text: 'T(k1)',
      nested: { deep: 'T(k2)' },
      list: ['T(k3)', 'plain'],
      untouched: 42,
    })
  })

  test('rehydrateBlobRefs passes non-ref scalars through unchanged', async () => {
    const resolve = async () => 'unused'
    expect(await rehydrateBlobRefs('hello', resolve)).toBe('hello')
    expect(await rehydrateBlobRefs(7, resolve)).toBe(7)
    expect(await rehydrateBlobRefs(null, resolve)).toBe(null)
  })
})
