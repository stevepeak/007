import { describe, expect, test } from 'bun:test'

import { stampEntry } from './run-log-entries'
import { stepRowFor } from './run-recorder'

const node = { id: 'n1', kind: 'branch' as const }

describe('stepRowFor', () => {
  test('a completed step carries output, meta and the routing decision', () => {
    const row = stepRowFor({
      node,
      sequence: 3,
      input: { a: 1 },
      outcome: {
        ok: true,
        result: {
          recordedOutput: { result: true },
          meta: { m: 1 },
          branchResult: 'yes',
          branchReasoning: 'because',
        },
      },
    })
    expect(row).toMatchObject({
      nodeId: 'n1',
      nodeKind: 'branch',
      sequence: 3,
      status: 'completed',
      output: { result: true },
      meta: { m: 1 },
      branchResult: { result: 'yes', reasoning: 'because' },
    })
    expect(row.finishedAt).toBeInstanceOf(Date)
  })

  test('a failed step stores the detailed form, not just the message', () => {
    const err = new Error('boom')
    const row = stepRowFor({
      node,
      sequence: 0,
      input: null,
      outcome: { ok: false, error: err },
    })
    expect(row.status).toBe('failed')
    // errorStored keeps the stack; errorMessage would be just "boom".
    expect(row.error).toContain('boom')
    expect(row.error).not.toBe('boom')
  })

  test('a plain-object throw is not stored as [object Object]', () => {
    const row = stepRowFor({
      node,
      sequence: 0,
      input: null,
      outcome: { ok: false, error: { code: 42 } },
    })
    expect(row.error).not.toContain('[object Object]')
  })

  test('an already-stored error passes through unchanged', () => {
    const row = stepRowFor({
      node,
      sequence: 0,
      input: null,
      outcome: { ok: false, stored: 'stored text' },
    })
    expect(row.error).toBe('stored text')
  })
})

describe('stampEntry', () => {
  test('fills the node identity the emitter left off', () => {
    const e = stampEntry({
      node: { id: 'n1', kind: 'agent' },
      seq: 4,
      entry: { level: 'info', message: 'hi' },
    })
    expect(e).toMatchObject({ nodeId: 'n1', nodeKind: 'agent', sequence: 4 })
    expect(typeof e.ts).toBe('number')
  })

  test('keeps what the emitter set', () => {
    const e = stampEntry({
      node: { id: 'n1', kind: 'agent' },
      seq: 4,
      entry: { level: 'info', message: 'hi', nodeId: 'other', ts: 1 },
    })
    expect(e.nodeId).toBe('other')
    expect(e.ts).toBe(1)
  })
})
