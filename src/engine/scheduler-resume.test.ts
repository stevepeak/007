import { describe, expect, test } from 'bun:test'

import { chainGraph } from './executor-test-helpers'
import { Scheduler } from './scheduler'

describe('Scheduler.seedResume', () => {
  test('marks replayed steps done and returns the next sequence', () => {
    const s = new Scheduler(chainGraph())
    s.seedTrigger({})
    const next = s.seedResume({
      steps: [{ nodeId: 'boom', sequence: 4, output: { ok: 1 } }],
    })
    expect(next).toBe(5)
    expect(s.getOutputs().get('boom')).toEqual({ ok: 1 })
    // `boom` is done, so the walk picks up at the node after it.
    const instruction = s.next()
    expect(instruction.type).toBe('execute')
    if (instruction.type === 'execute') {
      expect(instruction.node.id).toBe('after')
    }
  })

  test('no steps → 0', () => {
    const s = new Scheduler(chainGraph())
    s.seedTrigger({})
    expect(s.seedResume({ steps: [] })).toBe(0)
  })
})
