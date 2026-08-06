import { describe, expect, test } from 'bun:test'

import {
  emitNodeProgress,
  emitNodeStartProgress,
  nodeProgressMessage,
} from './node-progress'
import { createMemorySink } from './stream-sink'

// The user-facing progress line is opt-in: a step is silent unless its
// `informUser` mode is `static`. `dynamic` streams the agent's own reasoning/
// tool notes instead (and, being a separate mode, carries no static note); `off`
// says nothing.

describe('nodeProgressMessage', () => {
  test('an off node is silent (no derived title)', () => {
    expect(
      nodeProgressMessage(
        { id: 'n', kind: 'tool', informUser: { mode: 'off' } },
        undefined,
      ),
    ).toBe('')
  })

  test('interpolates the static note from run variables', () => {
    expect(
      nodeProgressMessage(
        {
          id: 'n',
          kind: 'tool',
          informUser: { mode: 'static', note: 'Looking up record ${n}' },
        },
        { n: '42' },
      ),
    ).toBe('Looking up record 42')
  })

  test('a dynamic (streaming) agent emits no static line', () => {
    expect(
      nodeProgressMessage(
        {
          id: 'a',
          kind: 'agent',
          informUser: { mode: 'dynamic', reasoning: true, tools: true },
        },
        undefined,
      ),
    ).toBe('')
  })

  test('a static agent shows its note', () => {
    expect(
      nodeProgressMessage(
        {
          id: 'a',
          kind: 'agent',
          informUser: { mode: 'static', note: 'Researching…' },
        },
        undefined,
      ),
    ).toBe('Researching…')
  })

  test('coerces a non-string value, so a numeric count reads naturally', () => {
    expect(
      nodeProgressMessage(
        {
          id: 'loop',
          kind: 'iteration',
          informUser: { mode: 'static', note: 'Processing ${n} recipes…' },
        },
        { n: 12 },
      ),
    ).toBe('Processing 12 recipes…')
  })
})

// An iteration's note can't be emitted at node start: `${n}` is the item count,
// which only exists once the list has been resolved. `emitNodeStartProgress`
// therefore skips iteration entirely and `runIteration` calls the unguarded
// `emitNodeProgress` later. The guard lives in this module so the inline and
// durable backends — both of which dispatch generically over node kind — can't
// disagree about it.

const iterationNode = {
  id: 'loop',
  kind: 'iteration',
  informUser: { mode: 'static' as const, note: 'Processing ${n} recipes…' },
}

describe('emitNodeStartProgress', () => {
  test('skips an iteration node — its note is emitted once the count is known', () => {
    const sink = createMemorySink()
    emitNodeStartProgress(sink, iterationNode, { n: 12 })
    expect(sink.logs).toEqual([])
  })

  test('emits for every other kind', () => {
    const sink = createMemorySink()
    emitNodeStartProgress(
      sink,
      { id: 'a', kind: 'agent', informUser: { mode: 'static', note: 'Hi' } },
      undefined,
    )
    expect(sink.logs.map((l) => l.message)).toEqual(['Hi'])
  })
})

describe('emitNodeProgress', () => {
  test('emits an iteration note with the count interpolated', () => {
    const sink = createMemorySink()
    emitNodeProgress(sink, iterationNode, { n: 12, total: 12 })
    expect(sink.logs.map((l) => l.message)).toEqual(['Processing 12 recipes…'])
    expect(sink.logs[0]?.level).toBe('progress')
  })

  test('the built-in count wins over a run variable that shares its name', () => {
    // `n` is a plausible run-variable name (the tool test above uses one). On an
    // iteration the author is unambiguously asking for the item count, so
    // `runIteration` spreads the built-ins last — this mirrors that bag.
    const promptVariables = { n: '42' }
    const sink = createMemorySink()
    emitNodeProgress(sink, iterationNode, {
      ...promptVariables,
      n: 12,
      total: 12,
    })
    expect(sink.logs.map((l) => l.message)).toEqual(['Processing 12 recipes…'])
  })
})
