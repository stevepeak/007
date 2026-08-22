import { describe, expect, test } from 'bun:test'
import type { WorkflowStep } from 'cloudflare:workers'

import { createCountingStep, createRunCounters } from './step-counter'

// A stand-in for the Workflows runtime with the one behavior that matters here:
// a journal. A step whose name was already settled returns its recorded value
// WITHOUT re-running the body — which is exactly what makes a replay look
// different from a first pass, and exactly what the counter must survive.
function fakeStep() {
  const journal = new Map<string, unknown>()
  const bodyRuns: string[] = []
  const step = {
    async do(name: string, ...rest: unknown[]) {
      const body = (rest[rest.length - 1] ?? rest[0]) as () => Promise<unknown>
      if (journal.has(name)) return journal.get(name)
      bodyRuns.push(name)
      const value = await body()
      journal.set(name, value)
      return value
    },
    async sleep(_name: string) {},
    async sleepUntil(_name: string) {},
    async waitForEvent(name: string) {
      return { payload: `event:${name}` }
    },
  }
  return { step: step as unknown as WorkflowStep, journal, bodyRuns }
}

/** A miniature run: envelope steps, three nodes × 3, one 4-item iteration. */
async function walk(step: WorkflowStep) {
  await step.do('load-graph', async () => 'graph')
  await step.do('begin-run', async () => null)
  for (const node of ['a', 'b']) {
    await step.do(`enter:${node}`, async () => null)
    await step.do(`run:${node}`, async () => null)
    await step.do(`record:${node}`, async () => null)
  }
  await step.do('enter:iter', async () => null)
  for (let i = 0; i < 4; i++) {
    await step.do(`iter:iter:${i}`, async () => null)
  }
  await step.do('record:iter', async () => null)
  await step.do('settle', async () => null)
}

describe('createCountingStep', () => {
  test('counts every billable call', async () => {
    const { step } = fakeStep()
    const counters = createRunCounters()
    await walk(createCountingStep(step, counters))
    // 2 envelope + 2 nodes × 3 + (enter + 4 items + record) + settle
    expect(counters.steps).toBe(15)
  })

  test('a replay re-accumulates to the IDENTICAL total', async () => {
    const { step, bodyRuns } = fakeStep()

    const first = createRunCounters()
    await walk(createCountingStep(step, first))

    // Same instance, same journal — the wake-up replay. Bodies short-circuit,
    // but the calls still happen, so the tally must land in the same place.
    const replay = createRunCounters()
    await walk(createCountingStep(step, replay))

    expect(replay.steps).toBe(first.steps)
    expect(bodyRuns).toHaveLength(15) // no body ran twice
  })

  test('waitForEvent counts — a parked callee still bills its step', async () => {
    const { step } = fakeStep()
    const counters = createRunCounters()
    const counting = createCountingStep(step, counters)
    await counting.do('spawn:n1', async () => null)
    await counting.waitForEvent('await:n1', { type: 'callee-done' })
    expect(counters.steps).toBe(2)
  })

  test('sleep and sleepUntil count', async () => {
    const { step } = fakeStep()
    const counters = createRunCounters()
    const counting = createCountingStep(step, counters)
    await counting.sleep('nap', '1 second')
    await counting.sleepUntil('later', new Date(0))
    expect(counters.steps).toBe(2)
  })

  test('a step that throws is still counted — it was issued and billed', async () => {
    const { step } = fakeStep()
    const counters = createRunCounters()
    const counting = createCountingStep(step, counters)
    await expect(
      counting.do('boom', async () => {
        throw new Error('node failed')
      }),
    ).rejects.toThrow('node failed')
    expect(counters.steps).toBe(1)
  })

  test('the wrapper passes return values through untouched', async () => {
    const { step } = fakeStep()
    const counting = createCountingStep(step, createRunCounters())
    expect(await counting.do('load-graph', async () => ({ nodes: [] }))).toEqual({
      nodes: [],
    })
    expect(
      await counting.waitForEvent('await:x', { type: 't' }),
    ).toMatchObject({ payload: 'event:await:x' })
  })
})
