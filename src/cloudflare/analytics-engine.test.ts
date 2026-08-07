import { describe, expect, test } from 'bun:test'

import type { TelemetryPoint } from '../analytics/points'

import { createAnalyticsEngineTelemetry } from './analytics-engine'

const POINT: TelemetryPoint = { indexes: ['wf-1'], blobs: ['step'], doubles: [0] }

function fakeDataset() {
  const written: unknown[] = []
  return {
    written,
    ds: { writeDataPoint: (p?: unknown) => void written.push(p) },
  }
}

describe('createAnalyticsEngineTelemetry', () => {
  test('writes through to the binding resolved at call time', () => {
    const { written, ds } = fakeDataset()
    const sink = createAnalyticsEngineTelemetry({ dataset: () => ds })
    sink.write(POINT)
    expect(written).toEqual([POINT])
    expect(sink.dropped()).toBe(0)
  })

  test('is inert — never throws — when the binding is absent', () => {
    const sink = createAnalyticsEngineTelemetry({ dataset: () => undefined })
    expect(() => sink.write(POINT)).not.toThrow()
  })

  test('a throwing binding is swallowed and counted, never propagated', () => {
    const sink = createAnalyticsEngineTelemetry({
      dataset: () => ({
        writeDataPoint: () => {
          throw new Error('AE exploded')
        },
      }),
    })
    expect(() => sink.write(POINT)).not.toThrow()
    expect(sink.dropped()).toBe(1)
  })

  test('caps at maxPoints and counts the overflow', () => {
    const { written, ds } = fakeDataset()
    const sink = createAnalyticsEngineTelemetry({ dataset: () => ds, maxPoints: 3 })
    for (let i = 0; i < 10; i++) sink.write(POINT)
    expect(written).toHaveLength(3)
    expect(sink.dropped()).toBe(7)
  })

  test('the dataset thunk is re-resolved on every write', () => {
    let current = fakeDataset()
    const sink = createAnalyticsEngineTelemetry({ dataset: () => current.ds })
    sink.write(POINT)
    const first = current
    current = fakeDataset()
    sink.write(POINT)
    expect(first.written).toHaveLength(1)
    expect(current.written).toHaveLength(1)
  })
})
