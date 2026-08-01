import { describe, expect, test } from 'bun:test'

import type { EvalRowRecord } from './evals'
import { buildEvalSnapshot, hashEvalSnapshot } from './eval-snapshot'

// The snapshot hash is PERSISTED and compared across runs to detect whether a
// Sample's effective definition changed and to dedup identical snapshots. Its
// wire format (the local `stableStringify`) is therefore frozen. These tests
// lock a known digest so any accidental change — most likely someone swapping in
// `storage/spec/util.ts`'s `stableStringify`, which handles nested `undefined`
// differently — fails loudly instead of silently invalidating stored hashes.

// A representative row whose fixtures contain a nested `undefined`, which is
// exactly where this stringify diverges from the spec/util one (`undefined` →
// the literal text `undefined` here, vs `"null"` there).
const row = {
  id: 'row-1',
  setId: 'set-1',
  name: 'Sample name',
  description: 'desc',
  initialCondition: {
    triggerInput: { text: 'hello' },
    promptVariables: { topic: 'law', empty: undefined },
  },
  fixtures: { toolA: { nested: undefined, keep: 1 } },
  checks: { op: 'and', checks: [] },
  sortOrder: 0,
  archived: false,
} as unknown as EvalRowRecord

const set = {
  id: 'set-1',
  name: 'Goal name',
  targetKind: 'agent',
  targetId: 'agent-1',
  targetVersion: null,
  triggerKind: 'chat',
}

const KNOWN_DIGEST =
  '171a5f7225a4c11990c30316652e29698c124f1b002e1dc8fe965705374e780b'

describe('hashEvalSnapshot', () => {
  test('produces the frozen digest for a known snapshot', async () => {
    const hash = await hashEvalSnapshot(buildEvalSnapshot(row, set))
    expect(hash).toBe(KNOWN_DIGEST)
  })

  test('is stable across object key ordering', async () => {
    const reordered = {
      ...row,
      initialCondition: {
        promptVariables: { empty: undefined, topic: 'law' },
        triggerInput: { text: 'hello' },
      },
    } as unknown as EvalRowRecord
    const hash = await hashEvalSnapshot(buildEvalSnapshot(reordered, set))
    expect(hash).toBe(KNOWN_DIGEST)
  })

  test('ignores cosmetic name/description changes', async () => {
    const renamed = { ...row, name: 'Renamed', description: 'other' }
    const renamedSet = { ...set, name: 'Renamed goal' }
    const hash = await hashEvalSnapshot(buildEvalSnapshot(renamed, renamedSet))
    expect(hash).toBe(KNOWN_DIGEST)
  })
})
