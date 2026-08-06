import { describe, expect, test } from 'bun:test'

import { executeWorkflow } from './executor'
import { createMemoryRunRecorder } from './run-recorder'
import { createMemorySink } from './stream-sink'
import { makeConfig } from './executor-test-helpers'

// The first-class user-facing progress feed: a node emits a `level: 'progress'`
// line at start ONLY when the author set a `progressNote` (interpolated from run
// variables) — note-less nodes stay silent, there is no derived-title fallback.
// An iteration follows the same rule but emits LATER (from `runIteration`, once
// the list resolves and `${n}` exists) and then adds a `Processing item i of n`
// line per item. These assert the engine contract through the in-process backend
// (no DB / Cloudflare).

const trigger = {
  id: 't',
  kind: 'trigger' as const,
  label: 'Go',
  position: { x: 0, y: 0 },
  config: { triggerKind: 'go' },
}
const output = (id: string, x: number, source: string) => ({
  id,
  kind: 'output' as const,
  label: 'Out',
  position: { x, y: 0 },
  config: { source: { kind: 'ref' as const, nodeId: source, path: '' } },
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
          output('o', 400, 'lookup'),
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

  test('a node without a progressNote stays silent (no derived title)', async () => {
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
          output('o', 400, 'lookup'),
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
    // No author progressNote → the node contributes nothing to the user feed.
    expect(progressLines(sink)).toEqual([])
  })

  // An iteration over a 3-element list. `informUser` is the knob under test, so
  // the caller supplies it; everything else is fixed scaffolding.
  const runIterationGraph = async (
    informUser: unknown,
    list: unknown[] = ['a', 'b', 'c'],
  ) => {
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
            config: { value: { kind: 'literal', value: list } },
          },
          {
            id: 'loop',
            kind: 'iteration' as const,
            label: 'Each',
            position: { x: 400, y: 0 },
            informUser,
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
                    config: { source: { kind: 'ref', nodeId: 'it', path: '' } },
                  },
                ],
                edges: [
                  { id: 'ie', source: 'it', target: 'io', condition: null },
                ],
              },
            },
          },
          output('o', 600, 'loop'),
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
    return progressLines(sink)
  }

  test('a static iteration announces the count, then ticks per item', async () => {
    const lines = await runIterationGraph({
      mode: 'static',
      note: 'Processing ${n} recipes…',
    })
    // The note leads — it is emitted the moment the list resolves, which is the
    // only point `${n}` is knowable — and appears exactly once.
    expect(lines[0]).toBe('Processing 3 recipes…')
    expect(lines.filter((l) => l === 'Processing 3 recipes…')).toHaveLength(1)
    expect(lines).toContain('Processing item 1 of 3')
    expect(lines).toContain('Processing item 3 of 3')
  })

  test('an iteration set to off is silent — ticks included', async () => {
    // Regression guard. The per-item lines used to be emitted unconditionally,
    // making iteration the one node kind that talked to the user with its
    // toggle off.
    expect(await runIterationGraph({ mode: 'off' })).toEqual([])
  })

  test('an iteration with no informUser defaults to silent', async () => {
    expect(await runIterationGraph(undefined)).toEqual([])
  })

  test('an empty list still announces zero rather than going quiet', async () => {
    // The author asked to be told how many items there are; "none" is an answer
    // the user wants, not a reason to say nothing.
    expect(
      await runIterationGraph(
        { mode: 'static', note: 'Processing ${n} recipes…' },
        [],
      ),
    ).toEqual(['Processing 0 recipes…'])
  })
})
