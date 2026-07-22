import { describe, expect, test } from 'bun:test'

import { executeWorkflow } from './executor'
import { createMemoryRunRecorder } from './run-recorder'
import { makeConfig } from './executor-test-helpers'

// trigger → {left, right} producers → aggregate → output. The two producers run
// in parallel; the aggregate waits for both and collects their outputs into one
// ordered list (edge-declaration order), which becomes the run output.
function aggregateGraph() {
  return {
    version: 1 as const,
    nodes: [
      {
        id: 't',
        kind: 'trigger',
        label: 'Go',
        position: { x: 0, y: 0 },
        config: { triggerKind: 'go' },
      },
      {
        id: 'left',
        kind: 'tool',
        label: 'Left',
        position: { x: 200, y: -50 },
        config: { toolId: 'left', args: {} },
      },
      {
        id: 'right',
        kind: 'tool',
        label: 'Right',
        position: { x: 200, y: 50 },
        config: { toolId: 'right', args: {} },
      },
      {
        id: 'agg',
        kind: 'aggregate',
        label: 'Aggregate',
        position: { x: 400, y: 0 },
        config: {},
      },
      {
        id: 'o',
        kind: 'output',
        label: 'Out',
        position: { x: 600, y: 0 },
        config: {},
      },
    ],
    edges: [
      { id: 'e1', source: 't', target: 'left', condition: null },
      { id: 'e2', source: 't', target: 'right', condition: null },
      { id: 'e3', source: 'left', target: 'agg', condition: null },
      { id: 'e4', source: 'right', target: 'agg', condition: null },
      { id: 'e5', source: 'agg', target: 'o', condition: null },
    ],
  }
}

describe('executor — aggregate node', () => {
  test('collects parallel producers into an ordered list', async () => {
    const recorder = createMemoryRunRecorder()
    const result = await executeWorkflow({
      graph: aggregateGraph(),
      triggerInput: { n: 1 },
      config: makeConfig(),
      runContext: { subjectId: 'acme', triggerKind: 'go' },
      recorder,
    })

    // One element per producer, in edge-declaration order (left, right).
    expect(result.output).toEqual([{ v: 'L' }, { v: 'R' }])
    expect(result.outputNodeId).toBe('o')

    const agg = recorder.steps.find((s) => s.nodeId === 'agg')
    expect(agg?.status).toBe('completed')
    expect(agg?.output).toEqual([{ v: 'L' }, { v: 'R' }])
    // The executor records the collect count as node meta.
    expect(agg?.meta).toEqual({ count: 2 })
  })
})
