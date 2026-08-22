import { describe, expect, test } from 'bun:test'

import { NodeOutputs, describeNode, resolveBinding } from './binding'

// Binding errors are read by workflow AUTHORS in the run viewer, so these tests
// pin the wording, not just the throw: a message that only carries uuids sends
// the author back to the graph JSON to find out which box is mis-wired.

const NODES = [
  { id: 'n-a4', label: 'Extract text', kind: 'tool' },
  { id: 'n-a8', label: 'Mark complete', kind: 'tool' },
  { id: 'n-b4', label: 'Result', kind: 'output' },
]

function outputs (seed: Record<string, unknown> = {}) {
  const map = new NodeOutputs(NODES)
  for (const [id, value] of Object.entries(seed)) map.set(id, value)
  return map
}

describe('describeNode', () => {
  test('names a known node by label and kind', () => {
    expect(describeNode(outputs(), 'n-a4')).toBe('"Extract text" (tool)')
  })

  test('falls back to the id for a plain Map with no graph behind it', () => {
    expect(describeNode(new Map(), 'n-a4')).toBe('node n-a4')
  })

  test('disambiguates duplicate labels with an id tail', () => {
    const map = new NodeOutputs([
      { id: 'first-0001', label: 'Mark complete', kind: 'tool' },
      { id: 'second-002', label: 'Mark complete', kind: 'tool' },
    ])
    expect(map.describe('first-0001')).toBe('"Mark complete" (tool …rst-0001)')
    expect(map.describe('second-002')).toBe('"Mark complete" (tool …cond-002)')
  })
})

describe('resolveBinding', () => {
  test('resolves a ref through its path', () => {
    const value = resolveBinding(
      { kind: 'ref', nodeId: 'n-a4', path: 'text' },
      outputs({ 'n-a4': { text: 'hello' } }),
      { nodeId: 'n-b4', name: 'output' },
    )
    expect(value).toBe('hello')
  })

  test('names both nodes when the producer never ran', () => {
    // The converging-branch-arms shape: an Output bound to the arm that lost.
    expect(() =>
      resolveBinding(
        { kind: 'ref', nodeId: 'n-a8', path: 'document' },
        outputs({ 'n-a4': { text: 'hello' } }),
        { nodeId: 'n-b4', name: 'output' },
      ),
    ).toThrow(
      /"Result" \(output\) can't resolve its 'output' input: it reads "Mark complete" \(tool\)\.document, but that node produced no output in this run/,
    )
  })

  test('calls out a ref that points outside the graph', () => {
    expect(() =>
      resolveBinding(
        { kind: 'ref', nodeId: 'n-deleted', path: 'text' },
        outputs(),
        { nodeId: 'n-b4', name: 'output' },
      ),
    ).toThrow(/references node n-deleted, which isn't part of this graph/)
  })

  test('a literal binding never touches the outputs map', () => {
    expect(
      resolveBinding({ kind: 'literal', value: 7 }, new Map(), {
        nodeId: 'n-b4',
        name: 'count',
      }),
    ).toBe(7)
  })
})
