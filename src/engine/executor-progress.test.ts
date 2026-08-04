import { describe, expect, test } from 'bun:test'

import { executeWorkflow } from './executor'
import { createMemoryRunRecorder } from './run-recorder'
import { createMemorySink } from './stream-sink'
import { makeConfig } from './executor-test-helpers'

// The first-class user-facing progress feed: every executed node emits ONE
// `level: 'progress'` line at start — the author's interpolated `progressNote`
// when set, else a derived `nodeSpanLabel` title. Iteration additionally emits
// a `Processing item i of n` line per item. These assert the engine contract
// through the in-process backend (no DB / Cloudflare).

const trigger = {
  id: 't',
  kind: 'trigger' as const,
  label: 'Go',
  position: { x: 0, y: 0 },
  config: { triggerKind: 'go' },
}
const output = (id: string, x: number) => ({
  id,
  kind: 'output' as const,
  label: 'Out',
  position: { x, y: 0 },
  config: {},
})

function progressLines(sink: ReturnType<typeof createMemorySink>): string[] {
  return sink.logs.filter((l) => l.level === 'progress').map((l) => l.message)
}

describe('executor — user-facing progress', () => {
  test('a node with a progressNote emits the interpolated note at start', async () => {
    const sink = createMemorySink()
    await executeWorkflow({
      graph: {
        version: 1 as const,
        nodes: [
          trigger,
          {
            id: 'lookup',
            kind: 'tool' as const,
            label: 'After',
            position: { x: 200, y: 0 },
            progressNote: 'Looking up record ${n}',
            config: { toolId: 'after', args: {} },
          },
          output('o', 400),
        ],
        edges: [
          { id: 'e1', source: 't', target: 'lookup', condition: null },
          { id: 'e2', source: 'lookup', target: 'o', condition: null },
        ],
      },
      triggerInput: { n: 42 },
      config: makeConfig(),
      runContext: {
        triggerKind: 'go',
        promptVariables: { n: '42' },
      },
      recorder: createMemoryRunRecorder(),
      sink,
    })
    expect(progressLines(sink)).toContain('Looking up record 42')
  })

  test('a node without a progressNote falls back to a derived title', async () => {
    const sink = createMemorySink()
    await executeWorkflow({
      graph: {
        version: 1 as const,
        nodes: [
          trigger,
          {
            id: 'lookup',
            kind: 'tool' as const,
            label: 'Fetch records',
            position: { x: 200, y: 0 },
            config: { toolId: 'after', args: {} },
          },
          output('o', 400),
        ],
        edges: [
          { id: 'e1', source: 't', target: 'lookup', condition: null },
          { id: 'e2', source: 'lookup', target: 'o', condition: null },
        ],
      },
      triggerInput: { n: 1 },
      config: makeConfig(),
      runContext: { triggerKind: 'go' },
      recorder: createMemoryRunRecorder(),
      sink,
    })
    // nodeSpanLabel → `Tool: <label>`.
    expect(progressLines(sink)).toContain('Tool: Fetch records')
  })

  test('an iteration emits a Processing item i of n line per item', async () => {
    const sink = createMemorySink()
    await executeWorkflow({
      graph: {
        version: 1 as const,
        nodes: [
          trigger,
          {
            id: 'src',
            kind: 'passthrough' as const,
            label: 'List',
            position: { x: 200, y: 0 },
            // Emit a literal array for the iteration to loop over.
            config: { value: { kind: 'literal', value: ['a', 'b', 'c'] } },
          },
          {
            id: 'loop',
            kind: 'iteration' as const,
            label: 'Each',
            position: { x: 400, y: 0 },
            config: {
              source: { kind: 'ref', nodeId: 'src', path: '' },
              concurrency: 1,
              stopOnError: true,
              subgraph: {
                version: 1 as const,
                nodes: [
                  {
                    id: 'it',
                    kind: 'trigger' as const,
                    label: 'Item',
                    position: { x: 0, y: 0 },
                    config: { triggerKind: 'iteration_item' },
                  },
                  {
                    id: 'io',
                    kind: 'output' as const,
                    label: 'ItemOut',
                    position: { x: 200, y: 0 },
                    config: {},
                  },
                ],
                edges: [
                  { id: 'ie', source: 'it', target: 'io', condition: null },
                ],
              },
            },
          },
          output('o', 600),
        ],
        edges: [
          { id: 'e1', source: 't', target: 'src', condition: null },
          { id: 'e2', source: 'src', target: 'loop', condition: null },
          { id: 'e3', source: 'loop', target: 'o', condition: null },
        ],
      },
      triggerInput: { n: 1 },
      config: makeConfig(),
      runContext: { triggerKind: 'go' },
      recorder: createMemoryRunRecorder(),
      sink,
    })
    const lines = progressLines(sink)
    expect(lines).toContain('Processing item 1 of 3')
    expect(lines).toContain('Processing item 3 of 3')
  })
})
