import { describe, expect, test } from 'bun:test'

import type { WorkflowGraph } from '../../engine'
import { describeChange } from './use-edit-history'

// Minimal builders — describeChange only reads node id/kind/label/position/config
// and edge id/source/target, so we cast past the full discriminated-union schema.
function node(
  id: string,
  kind: string,
  label: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    kind,
    label,
    position: { x: 0, y: 0 },
    config: {},
    ...extra,
  }
}

function edge(id: string, source: string, target: string) {
  return { id, source, target, condition: null }
}

function graph(
  nodes: ReturnType<typeof node>[],
  edges: ReturnType<typeof edge>[] = [],
): WorkflowGraph {
  return { version: 1, nodes, edges } as unknown as WorkflowGraph
}

const trigger = node('t', 'trigger', 'Manual start')
const output = node('o', 'output', 'Output')
const base = graph([trigger, output])

describe('describeChange', () => {
  test('names a single added node with its kind', () => {
    const next = graph([trigger, output, node('a', 'agent', 'Summarize document')])
    expect(describeChange(base, next)).toBe('Added "Summarize document" agent')
  })

  test('humanizes hyphenated kinds', () => {
    const next = graph([
      trigger,
      output,
      node('f', 'feature-request', 'Wishlist'),
    ])
    expect(describeChange(base, next)).toBe('Added "Wishlist" feature request')
  })

  test('collapses multiple adds to a count', () => {
    const next = graph([
      trigger,
      output,
      node('a', 'agent', 'One'),
      node('b', 'tool', 'Two'),
    ])
    expect(describeChange(base, next)).toBe('Added 2 nodes')
  })

  test('names a single removed node', () => {
    const withAgent = graph([trigger, output, node('a', 'agent', 'Summarize')])
    expect(describeChange(withAgent, base)).toBe('Removed "Summarize" agent')
  })

  test('counts multiple removes', () => {
    const bigger = graph([
      trigger,
      output,
      node('a', 'agent', 'One'),
      node('b', 'tool', 'Two'),
    ])
    expect(describeChange(bigger, base)).toBe('Removed 2 nodes')
  })

  test('names both endpoints of a new connection', () => {
    const a = node('a', 'agent', 'Fetch')
    const b = node('b', 'agent', 'Summarize')
    const prev = graph([a, b])
    const next = graph([a, b], [edge('e1', 'a', 'b')])
    expect(describeChange(prev, next)).toBe('Connected "Fetch" → "Summarize"')
  })

  test('names both endpoints of a removed connection', () => {
    const a = node('a', 'agent', 'Fetch')
    const b = node('b', 'agent', 'Summarize')
    const prev = graph([a, b], [edge('e1', 'a', 'b')])
    const next = graph([a, b])
    expect(describeChange(prev, next)).toBe(
      'Removed connection "Fetch" → "Summarize"',
    )
  })

  test('reports a rename when only the label changed', () => {
    const prev = graph([trigger, output, node('a', 'agent', 'Old name')])
    const next = graph([trigger, output, node('a', 'agent', 'New name')])
    expect(describeChange(prev, next)).toBe('Renamed node to "New name"')
  })

  test('reports settings edit when only config changed', () => {
    const prev = graph([
      trigger,
      output,
      node('a', 'agent', 'Summarize', { config: { maxTurns: 3 } }),
    ])
    const next = graph([
      trigger,
      output,
      node('a', 'agent', 'Summarize', { config: { maxTurns: 5 } }),
    ])
    expect(describeChange(prev, next)).toBe('Edited "Summarize" settings')
  })

  test('reports a move when only the position changed', () => {
    const prev = graph([trigger, output, node('a', 'agent', 'Summarize')])
    const next = graph([
      trigger,
      output,
      node('a', 'agent', 'Summarize', { position: { x: 100, y: 40 } }),
    ])
    expect(describeChange(prev, next)).toBe('Moved "Summarize"')
  })

  test('ellipsizes very long node names', () => {
    const longName = 'A'.repeat(50)
    const next = graph([trigger, output, node('a', 'agent', longName)])
    const msg = describeChange(base, next)
    expect(msg.startsWith('Added "')).toBe(true)
    expect(msg).toContain('…')
    // 32-char cap: 31 chars + ellipsis inside the quotes.
    expect(msg).toBe(`Added "${'A'.repeat(31)}…" agent`)
  })

  test('falls back to a generic label when nothing identifiable changed', () => {
    expect(describeChange(base, base)).toBe('Edited workflow')
  })
})
