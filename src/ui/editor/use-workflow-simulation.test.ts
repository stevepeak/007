import { describe, expect, test } from 'bun:test'

import type { WorkflowGraph } from '../../engine'
import { buildSimulatedItems } from './use-workflow-simulation'

// The simulate preview walks the graph topologically and emits one synthetic
// progress line per executable node THAT HAS an author `progressNote` — note-less
// nodes stay silent (no derived-title fallback) — plus sample `item i of n` ticks
// for iterations. Bookends never appear.

const node = (
  id: string,
  kind: string,
  label: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  kind,
  label,
  position: { x: 0, y: 0 },
  ...extra,
})

describe('buildSimulatedItems', () => {
  test('emits progress lines in topological order, skipping bookends', () => {
    const graph = {
      version: 1,
      nodes: [
        node('t', 'trigger', 'Go', { config: { triggerKind: 'manual' } }),
        node('a', 'tool', 'Fetch', {
          progressNote: 'Fetching records',
          config: { toolId: 'x', args: {} },
        }),
        node('b', 'tool', 'Summarize', { config: { toolId: 'y', args: {} } }),
        node('o', 'output', 'Out', { config: {} }),
      ],
      edges: [
        { id: 'e1', source: 't', target: 'a', condition: null },
        { id: 'e2', source: 'a', target: 'b', condition: null },
        { id: 'e3', source: 'b', target: 'o', condition: null },
      ],
    } as unknown as WorkflowGraph

    const items = buildSimulatedItems(graph)
    const messages = items.map((i) => (i.kind === 'progress' ? i.message : ''))
    // Trigger + output (bookends) excluded; only the node with an author note
    // surfaces a line — the note-less "Summarize" tool stays silent.
    expect(messages).toEqual(['Fetching records'])
  })

  test('an iteration expands into sample item ticks', () => {
    const graph = {
      version: 1,
      nodes: [
        node('t', 'trigger', 'Go', { config: { triggerKind: 'manual' } }),
        node('loop', 'iteration', 'Each doc', {
          progressNote: 'Reviewing documents',
          config: {
            source: { kind: 'ref', nodeId: 't', path: '' },
            concurrency: 1,
            stopOnError: true,
            subgraph: {
              version: 1,
              nodes: [
                node('it', 'trigger', 'Item', {
                  config: { triggerKind: 'iteration_item' },
                }),
                node('io', 'output', 'ItemOut', { config: {} }),
              ],
              edges: [
                { id: 'ie', source: 'it', target: 'io', condition: null },
              ],
            },
          },
        }),
        node('o', 'output', 'Out', { config: {} }),
      ],
      edges: [
        { id: 'e1', source: 't', target: 'loop', condition: null },
        { id: 'e2', source: 'loop', target: 'o', condition: null },
      ],
    } as unknown as WorkflowGraph

    const messages = buildSimulatedItems(graph).map((i) =>
      i.kind === 'progress' ? i.message : '',
    )
    expect(messages[0]).toBe('Reviewing documents')
    expect(messages).toContain('Processing item 1 of 3')
    expect(messages).toContain('Processing item 3 of 3')
  })
})
