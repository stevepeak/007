import { describe, expect, test } from 'bun:test'

import { createMemoryTelemetrySink } from '../analytics/sink'
import { createMemoryRunRecorder, type RecordStepArgs } from '../engine/run-recorder'

import { runDims, withRunCounts } from './graph-workflow-telemetry'
import { createRunCounters } from './step-counter'

const RUN_CONTEXT = {
  triggerKind: 'chat',
  traceId: 'f'.repeat(32),
  isEval: true,
  simulate: true,
}

function record(over: Partial<RecordStepArgs>): RecordStepArgs {
  return {
    nodeId: 'n',
    nodeKind: 'agent',
    status: 'completed',
    sequence: 0,
    input: {},
    ...over,
  }
}

describe('runDims', () => {
  test('carries the eval + simulate signals telemetry partitions on', () => {
    const dims = runDims({
      workflowId: 'wf-1',
      workflowVersionId: 'ver-1',
      runId: 'run-1',
      runContext: RUN_CONTEXT,
    })
    expect(dims).toEqual({
      workflowId: 'wf-1',
      workflowVersionId: 'ver-1',
      runId: 'run-1',
      triggerKind: 'chat',
      traceId: 'f'.repeat(32),
      isEval: true,
      simulate: true,
    })
  })
})

describe('withRunCounts', () => {
  function harness() {
    const counters = createRunCounters()
    const inner = createMemoryRunRecorder()
    return { counters, inner, recorder: withRunCounts(inner, counters) }
  }

  test('counts terminal top-level nodes once, not their opening record', async () => {
    const { counters, recorder } = harness()
    await recorder.record(record({ nodeId: 'a', status: 'running' }))
    await recorder.record(record({ nodeId: 'a', status: 'completed' }))
    await recorder.record(record({ nodeId: 'b', status: 'completed' }))
    expect(counters.nodes).toBe(2)
  })

  test('the trigger and output nodes are envelope, not graph work', async () => {
    const { counters, recorder } = harness()
    await recorder.record(record({ nodeId: 't', nodeKind: 'trigger' }))
    await recorder.record(record({ nodeId: 'o', nodeKind: 'output' }))
    await recorder.record(record({ nodeId: 'a', nodeKind: 'agent' }))
    expect(counters.nodes).toBe(1)
  })

  test('iteration inner steps belong to their container, not the node count', async () => {
    const { counters, recorder } = harness()
    await recorder.record(
      record({
        nodeId: 'iter',
        nodeKind: 'iteration',
        meta: { total: 5, concurrency: 2, stopOnError: false },
      }),
    )
    for (let i = 0; i < 5; i++) {
      await recorder.record(
        record({ nodeId: 'inner', parentNodeId: 'iter', itemIndex: i }),
      )
    }
    expect(counters.nodes).toBe(1)
    expect(counters.iterationItems).toBe(5)
  })

  test('failures are counted wherever they happen', async () => {
    const { counters, recorder } = harness()
    await recorder.record(record({ nodeId: 'a', status: 'failed' }))
    await recorder.record(
      record({ nodeId: 'inner', itemIndex: 2, status: 'failed' }),
    )
    expect(counters.failedNodes).toBe(2)
    expect(counters.nodes).toBe(1) // the item's failure isn't a top-level node
  })

  test('an iteration whose meta lost its total contributes no items', async () => {
    const { counters, recorder } = harness()
    await recorder.record(record({ nodeId: 'iter', nodeKind: 'iteration' }))
    expect(counters.iterationItems).toBe(0)
  })

  test('still writes through to the wrapped recorder', async () => {
    const { inner, recorder } = harness()
    await recorder.record(record({ nodeId: 'a', output: { text: 'hi' } }))
    expect(inner.steps).toHaveLength(1)
    expect(inner.steps[0].output).toEqual({ text: 'hi' })
  })
})

test('a telemetered recorder and the counter compose without interfering', async () => {
  const counters = createRunCounters()
  const sink = createMemoryTelemetrySink()
  const inner = createMemoryRunRecorder()
  const { withStepTelemetry } = await import('../analytics/recorder')
  const recorder = withRunCounts(
    withStepTelemetry(
      inner,
      sink,
      runDims({
        workflowId: 'wf-1',
        workflowVersionId: 'ver-1',
        runId: 'run-1',
        runContext: { triggerKind: 'chat' },
      }),
    ),
    counters,
  )
  await recorder.record(record({ nodeId: 'a', status: 'running' }))
  await recorder.record(record({ nodeId: 'a', status: 'completed' }))
  expect(counters.nodes).toBe(1)
  expect(sink.points).toHaveLength(1)
  expect(inner.steps).toHaveLength(1)
})
