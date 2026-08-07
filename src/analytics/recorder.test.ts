import { describe, expect, test } from 'bun:test'

import { createMemoryRunRecorder } from '../engine/run-recorder'

import type { RunDims } from './points'
import { withStepTelemetry } from './recorder'
import { createMemoryTelemetrySink } from './sink'

const DIMS: RunDims = {
  workflowId: 'wf-1',
  workflowVersionId: 'ver-1',
  runId: 'run-1',
  triggerKind: 'chat',
}

function harness() {
  const recorder = createMemoryRunRecorder()
  const sink = createMemoryTelemetrySink()
  return { recorder, sink, wrapped: withStepTelemetry(recorder, sink, DIMS) }
}

describe('withStepTelemetry', () => {
  test('the opening `running` record emits nothing', async () => {
    const { sink, wrapped } = harness()
    await wrapped.record({
      nodeId: 'n1',
      nodeKind: 'agent',
      status: 'running',
      sequence: 1,
      input: {},
      startedAt: new Date(),
    })
    expect(sink.points).toHaveLength(0)
  })

  test('a node recorded running-then-terminal emits exactly one point', async () => {
    const { recorder, sink, wrapped } = harness()
    const base = {
      nodeId: 'n1',
      nodeKind: 'agent' as const,
      sequence: 1,
      input: {},
    }
    await wrapped.record({ ...base, status: 'running', startedAt: new Date(1) })
    await wrapped.record({
      ...base,
      status: 'completed',
      output: { text: 'hi' },
      startedAt: new Date(1),
      finishedAt: new Date(101),
    })

    expect(sink.points).toHaveLength(1)
    expect(sink.points[0].blobs[9]).toBe('completed') // blob10 status
    expect(sink.points[0].doubles[4]).toBe(100) // double5 latencyMs
    // The underlying row is still upserted in place, not appended.
    expect(recorder.steps).toHaveLength(1)
  })

  test('every terminal status emits — skipped and failed included', async () => {
    const { sink, wrapped } = harness()
    for (const [i, status] of (['completed', 'failed', 'skipped'] as const).entries()) {
      await wrapped.record({
        nodeId: `n${i}`,
        nodeKind: 'tool',
        status,
        sequence: i,
        input: {},
      })
    }
    expect(sink.points.map((p) => p.blobs[9])).toEqual([
      'completed',
      'failed',
      'skipped',
    ])
  })

  test('the wrapped recorder still writes through', async () => {
    const { recorder, wrapped } = harness()
    await wrapped.record({
      nodeId: 'n1',
      nodeKind: 'branch',
      status: 'completed',
      sequence: 1,
      input: {},
      branchResult: { result: 'yes', reasoning: 'because' },
    })
    expect(recorder.steps[0].branchResult).toEqual({
      result: 'yes',
      reasoning: 'because',
    })
  })

  test('a sub-recorder’s parent/item dimensions reach the point', async () => {
    const { sink, wrapped } = harness()
    await wrapped.record({
      nodeId: 'inner',
      nodeKind: 'agent',
      status: 'completed',
      sequence: 2,
      input: {},
      parentNodeId: 'iter-1',
      itemIndex: 4,
      meta: {
        model: 'm1',
        steps: [{ stepNumber: 1, toolCalls: [] }],
        totalUsage: { inputTokens: 10, outputTokens: 5 },
      },
    })
    expect(sink.points[0].blobs[13]).toBe('iter-1') // blob14 parentNodeId
    expect(sink.points[0].doubles[3]).toBe(4) // double4 itemIndex
    expect(sink.points[0].doubles[5]).toBe(10) // double6 inputTokens
  })

  test('a sink that throws costs a point, never the run', async () => {
    const inner = createMemoryRunRecorder()
    const exploding = {
      write() {
        throw new Error('binding exploded')
      },
      dropped: () => 0,
    }
    const wrapped = withStepTelemetry(inner, exploding, DIMS)
    await wrapped.record({
      nodeId: 'n1',
      nodeKind: 'agent',
      status: 'completed',
      sequence: 1,
      input: {},
      output: { text: 'hi' },
    })
    // The step still persisted — telemetry is additive and never load-bearing.
    expect(inner.steps).toHaveLength(1)
  })

  test('a failing inner recorder emits no point — D1 is the source of truth', async () => {
    const sink = createMemoryTelemetrySink()
    const exploding = {
      record: () => Promise.reject(new Error('d1 down')),
    }
    const wrapped = withStepTelemetry(exploding, sink, DIMS)
    await expect(
      wrapped.record({
        nodeId: 'n1',
        nodeKind: 'agent',
        status: 'completed',
        sequence: 1,
        input: {},
      }),
    ).rejects.toThrow('d1 down')
    expect(sink.points).toHaveLength(0)
  })
})
