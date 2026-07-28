import { describe, expect, test } from 'bun:test'

import type { PassthroughNode } from '../graph'
import { executePassthroughNode } from './passthrough'

// Build a minimal Passthrough node with the given config.
function node(config: PassthroughNode['config']): PassthroughNode {
  return {
    id: 'p',
    kind: 'passthrough',
    label: 'Passthrough',
    position: { x: 0, y: 0 },
    config,
  }
}

describe('executePassthroughNode', () => {
  test('value mode: emits the resolved binding UNWRAPPED', async () => {
    const outputs = new Map<string, unknown>([
      ['trigger', { userProvidedName: 'Venice Letter Agreement' }],
    ])
    const r = await executePassthroughNode({
      node: node({
        value: { kind: 'ref', nodeId: 'trigger', path: 'userProvidedName' },
      }),
      input: undefined,
      nodeOutputs: outputs,
    })
    // Not wrapped in an object — the bare value flows through.
    expect(r.output).toBe('Venice Letter Agreement')
  })

  test('fields mode: builds an object matching a sibling arm shape', async () => {
    // The provided-name arm must match the generate-name agent's `{ name }` so
    // both feed a Race the identical shape.
    const outputs = new Map<string, unknown>([
      ['trigger', { userProvidedName: 'Venice Letter Agreement' }],
    ])
    const r = await executePassthroughNode({
      node: node({
        fields: {
          name: { kind: 'ref', nodeId: 'trigger', path: 'userProvidedName' },
        },
      }),
      input: undefined,
      nodeOutputs: outputs,
    })
    expect(r.output).toEqual({ name: 'Venice Letter Agreement' })
  })

  test('fields mode: mixes refs and literals across keys', async () => {
    const outputs = new Map<string, unknown>([['a', { title: 'Contract' }]])
    const r = await executePassthroughNode({
      node: node({
        fields: {
          name: { kind: 'ref', nodeId: 'a', path: 'title' },
          source: { kind: 'literal', value: 'user' },
        },
      }),
      input: undefined,
      nodeOutputs: outputs,
    })
    expect(r.output).toEqual({ name: 'Contract', source: 'user' })
  })

  test('identity mode: no config forwards the input untouched', async () => {
    const input = { kind: 'contract', pages: 3 }
    const r = await executePassthroughNode({
      node: node({}),
      input,
      nodeOutputs: new Map(),
    })
    // Same reference — a pure pass-through, no copy/reshape.
    expect(r.output).toBe(input)
  })

  test('empty fields object falls back to identity', async () => {
    const input = 'raw'
    const r = await executePassthroughNode({
      node: node({ fields: {} }),
      input,
      nodeOutputs: new Map(),
    })
    expect(r.output).toBe('raw')
  })

  test('rehydrate is applied to resolved values', async () => {
    const outputs = new Map<string, unknown>([['a', { ref: 'blob:123' }]])
    const r = await executePassthroughNode({
      node: node({
        fields: { text: { kind: 'ref', nodeId: 'a', path: 'ref' } },
      }),
      input: undefined,
      nodeOutputs: outputs,
      rehydrate: (v) =>
        Promise.resolve(v === 'blob:123' ? 'real text' : v),
    })
    expect(r.output).toEqual({ text: 'real text' })
  })

  test('propagates a clear error when a ref points at a node with no output', async () => {
    // The "referenced node has no recorded output" throw that a Save node hits
    // when it refs a skipped branch arm — here surfaced at the Passthrough.
    await expect(
      executePassthroughNode({
        node: node({ value: { kind: 'ref', nodeId: 'missing', path: '' } }),
        input: undefined,
        nodeOutputs: new Map(),
      }),
    ).rejects.toThrow(/references node missing which has no recorded output/)
  })
})
