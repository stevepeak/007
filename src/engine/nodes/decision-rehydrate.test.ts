import { describe, expect, test } from 'bun:test'

import { makeBlobRef } from '../blob-ref'
import type { BranchNode, SwitchNode } from '../graph-schema'

import { executeBranchNode } from './branch'
import { executeSwitchNode } from './switch'

// Branch and Switch are the two nodes that INTERPRET an upstream value rather
// than forward it, which makes them the two that a blob pointer breaks
// silently: a pointer compared against real text is simply not equal, and the
// run keeps going down the wrong edge with a confident reasoning line. Every
// other node kind either rehydrates already (agent/tool/passthrough/transform)
// or passes the value through untouched (aggregate/race).

const SPILLED = makeBlobRef({
  key: 'spill/1',
  contentType: 'text/plain',
  preview: 'APPROV',
})

// Stands in for the host resolver: turns the one known pointer back into the
// text it was made from.
async function rehydrate(value: unknown): Promise<unknown> {
  return value === SPILLED ? 'APPROVED' : value
}

const base = {
  position: { x: 0, y: 0 },
  label: 'Decide',
  informUser: { mode: 'off' as const },
}

function branchNode(config: Partial<BranchNode['config']> = {}): BranchNode {
  return {
    ...base,
    id: 'b1',
    kind: 'branch',
    config: { operator: 'equals', value: 'APPROVED', ...config },
  }
}

function switchNode(config: Partial<SwitchNode['config']> = {}): SwitchNode {
  return {
    ...base,
    id: 's1',
    kind: 'switch',
    config: {
      cases: [{ key: 'A', value: { kind: 'literal', value: 'APPROVED' } }],
      ...config,
    },
  }
}

describe('branch against a spilled value', () => {
  test('routes on the pointer’s real text, not the pointer', async () => {
    const r = await executeBranchNode({
      node: branchNode(),
      input: SPILLED,
      nodeOutputs: new Map(),
      rehydrate,
    })
    expect(r.result).toBe('yes')
  })

  test('without a rehydrate the same input mis-routes — the bug this guards', async () => {
    const r = await executeBranchNode({
      node: branchNode(),
      input: SPILLED,
      nodeOutputs: new Map(),
    })
    expect(r.result).toBe('no')
  })

  test('rehydrates a value reached through a `source` ref', async () => {
    const r = await executeBranchNode({
      node: branchNode({
        source: { kind: 'ref', nodeId: 'up', path: 'text' },
      }),
      input: undefined,
      nodeOutputs: new Map([['up', { text: SPILLED }]]),
      rehydrate,
    })
    expect(r.result).toBe('yes')
  })

  test('an ordinary value is unaffected by the rehydrate', async () => {
    const r = await executeBranchNode({
      node: branchNode(),
      input: 'APPROVED',
      nodeOutputs: new Map(),
      rehydrate,
    })
    expect(r.result).toBe('yes')
  })
})

describe('switch against a spilled value', () => {
  test('matches the case on the pointer’s real text', async () => {
    const r = await executeSwitchNode({
      node: switchNode(),
      input: SPILLED,
      nodeOutputs: new Map(),
      rehydrate,
    })
    expect(r.result).toBe('A')
  })

  test('falls to else without a rehydrate — the bug this guards', async () => {
    const r = await executeSwitchNode({
      node: switchNode(),
      input: SPILLED,
      nodeOutputs: new Map(),
    })
    expect(r.result).toBe('else')
  })

  test('rehydrates a ref-valued CASE too, not just the subject', async () => {
    const r = await executeSwitchNode({
      node: switchNode({
        cases: [{ key: 'A', value: { kind: 'ref', nodeId: 'up', path: '' } }],
      }),
      input: 'APPROVED',
      nodeOutputs: new Map([['up', SPILLED]]),
      rehydrate,
    })
    expect(r.result).toBe('A')
  })

  test('still picks the FIRST matching case, not merely a matching one', async () => {
    const r = await executeSwitchNode({
      node: switchNode({
        cases: [
          { key: 'A', value: { kind: 'literal', value: 'OTHER' } },
          { key: 'B', value: { kind: 'literal', value: 'APPROVED' } },
          { key: 'C', value: { kind: 'literal', value: 'APPROVED' } },
        ],
      }),
      input: SPILLED,
      nodeOutputs: new Map(),
      rehydrate,
    })
    expect(r.result).toBe('B')
  })
})
