import { describe, expect, test } from 'bun:test'

import { deltaChannelFor } from './executor'
import { createMemorySink, type StreamSink } from './stream-sink'

// Which node may write the answer is the whole safety property of the delta
// channel: hand it to the wrong node and an intermediate agent's working notes
// render to the reader as though they were the answer.
describe('deltaChannelFor', () => {
  const streamingSink = (): StreamSink & { written: string[] } => {
    const written: string[] = []
    return { delta: (t) => void written.push(t), written }
  }

  test('the answer-producing node gets a working channel', () => {
    const sink = streamingSink()
    const delta = deltaChannelFor(sink, new Set(['answer']), 'answer')
    expect(delta).toBeDefined()
    void delta?.('hello')
    expect(sink.written).toEqual(['hello'])
  })

  test('any other node gets nothing', () => {
    const sink = streamingSink()
    expect(deltaChannelFor(sink, new Set(['answer']), 'middle')).toBeUndefined()
    expect(sink.written).toEqual([])
  })

  test('a sink that cannot stream never yields a channel', () => {
    // The durable backend's case: it defines no `delta`, so no node streams
    // regardless of what the graph says.
    const sink = createMemorySink()
    expect(sink.delta).toBeUndefined()
    expect(deltaChannelFor(sink, new Set(['answer']), 'answer')).toBeUndefined()
  })

  test('a graph that names no answer node streams nothing', () => {
    const sink = streamingSink()
    expect(deltaChannelFor(sink, new Set(), 'answer')).toBeUndefined()
  })

  test('every candidate arm gets a channel', () => {
    // Multiple Outputs (one per branch arm) are legal; only the arm that runs
    // will emit, so both candidates must be able to.
    const sink = streamingSink()
    const ids = new Set(['armA', 'armB'])
    expect(deltaChannelFor(sink, ids, 'armA')).toBeDefined()
    expect(deltaChannelFor(sink, ids, 'armB')).toBeDefined()
    expect(deltaChannelFor(sink, ids, 'other')).toBeUndefined()
  })
})
