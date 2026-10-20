import { describe, expect, test } from 'bun:test'

import { recordedUpdate, type HandlerCtx } from './shared'

describe('recordedUpdate', () => {
  test('logs the fields that moved, with both images, after the write', async () => {
    let row = { name: 'Old', color: 'red' }
    const changes: Parameters<HandlerCtx['change']>[0][] = []
    const out = await recordedUpdate({
      c: { change: async (input) => void changes.push(input) },
      entityKind: 'agent',
      entityId: 'a1',
      action: 'update',
      load: async () => ({ ...row }),
      write: async () => {
        row = { ...row, name: 'New' }
      },
      diff: (a, b) => {
        return (Object.keys(a) as (keyof typeof a)[]).filter((k) => a[k] !== b[k])
      },
      fallbackFields: ['name'],
      note: (r) => r.name,
    })
    expect(out).toEqual({
      before: { name: 'Old', color: 'red' },
      after: { name: 'New', color: 'red' },
    })
    expect(changes).toEqual([
      {
        entityKind: 'agent',
        entityId: 'a1',
        action: 'update',
        fields: ['name'],
        before: { name: 'Old', color: 'red' },
        after: { name: 'New', color: 'red' },
        note: 'New',
      },
    ])
  })
})
