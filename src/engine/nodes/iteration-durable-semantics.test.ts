import { describe, expect, test } from 'bun:test'

import { buildIterationSubgraph, type IterationNode } from '../graph'

import { runIteration } from './iteration'

// What `concurrency` and `stopOnError` MEAN once an item is its own workflow
// instance rather than a `step.do` inside the parent's (NEW-174).
//
// The decision: **windowed** concurrency and **drain** on error — and the pool
// `runIteration` already drives delivers both, so the durable backend supplies
// a `runItem` that spawns a child and parks on its event, and inherits the
// semantics rather than reimplementing them. These tests pin that down, using a
// `runItem` shaped like the durable one (spawn, then park until the child
// reports) so the properties are asserted against the real call pattern.
//
// The third test is the one replay safety rests on: every step and event name
// the durable path issues is derived from the ITEM INDEX, so the set of names a
// replay produces matches the journal even though the pool hands indices to
// workers in completion order.

function iterNode(config: Partial<IterationNode['config']> = {}): IterationNode {
  return {
    id: 'it',
    kind: 'iteration',
    position: { x: 0, y: 0 },
    label: 'Iterate',
    informUser: { mode: 'off' },
    config: {
      concurrency: 4,
      stopOnError: false,
      itemExecution: 'durable',
      subgraph: buildIterationSubgraph(),
      ...config,
    },
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Stands in for the durable `runItem`: spawn a child instance, then park on
 * its report. Records both halves so a test can tell "was it started" from
 * "was it allowed to finish". */
function durableItemHarness(childMs: (index: number) => number) {
  const spawned: number[] = []
  const settled: number[] = []
  const runItem = async (item: unknown, index: number) => {
    spawned.push(index)
    await delay(childMs(index))
    if (item === 'boom') throw new Error(`item ${index} failed`)
    settled.push(index)
    return item
  }
  return { spawned, settled, runItem }
}

describe('durable iteration semantics', () => {
  test('windowed: never more than `concurrency` children in flight at once', async () => {
    let inFlight = 0
    let peak = 0
    const r = await runIteration({
      node: iterNode({ concurrency: 3 }),
      list: [0, 1, 2, 3, 4, 5, 6, 7],
      runItem: async (item) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await delay(5)
        inFlight--
        return item
      },
    })

    // The knob keeps its meaning in durable mode. It no longer bounds the
    // PARENT's budget (a parked parent costs nothing and each child has its own
    // budget) — it throttles what the children hit: model provider rate limits,
    // D1, whatever the subgraph calls.
    expect(peak).toBe(3)
    expect(r.results).toHaveLength(8)
  })

  test('drain: a failed item stops new spawns but lets in-flight children finish', async () => {
    // Item 1 fails immediately; items 0 and 2 are already in flight and slow.
    const h = durableItemHarness((i) => (i === 1 ? 1 : 40))

    await expect(
      runIteration({
        node: iterNode({ concurrency: 3, stopOnError: true }),
        list: ['a', 'boom', 'c', 'd', 'e', 'f'],
        runItem: h.runItem,
      }),
    ).rejects.toThrow('item 1 failed')

    // Nothing past the initial window was ever started — no orphan instances.
    expect(h.spawned.sort()).toEqual([0, 1, 2])
    // ...and the two already-running children were awaited rather than
    // abandoned. This is why drain beats terminate: a child killed mid-write
    // leaves a half-written recipe, and we cannot un-write it.
    expect(h.settled.sort()).toEqual([0, 2])
  })

  test('drain applies even when the failure is the very first item', async () => {
    const h = durableItemHarness((i) => (i === 0 ? 1 : 30))

    await expect(
      runIteration({
        node: iterNode({ concurrency: 2, stopOnError: true }),
        list: ['boom', 'b', 'c', 'd'],
        runItem: h.runItem,
      }),
    ).rejects.toThrow('item 0 failed')

    expect(h.spawned.sort()).toEqual([0, 1])
    expect(h.settled).toEqual([1])
  })

  test('stopOnError=false runs every item and reports the failures positionally', async () => {
    const h = durableItemHarness(() => 1)
    const r = await runIteration({
      node: iterNode({ concurrency: 2, stopOnError: false }),
      list: ['a', 'boom', 'c'],
      runItem: h.runItem,
    })

    expect(h.spawned.sort()).toEqual([0, 1, 2])
    expect(r.meta.items.find((i) => i.index === 1)?.status).toBe('failed')
    expect(r.results[0]).toBe('a')
    expect(r.results[2]).toBe('c')
  })

  test('every index is dispatched exactly once, whatever order workers claim them in', async () => {
    // Wildly uneven durations, so workers finish out of order and the shared
    // cursor hands out indices in a completion-dependent order. The durable
    // path names its `spawn:`/`await:` steps from the INDEX, so the set of
    // names is the same either way — which is what makes a replay match the
    // journal instead of minting a second child.
    const h = durableItemHarness((i) => (i % 3) * 7 + 1)
    await runIteration({
      node: iterNode({ concurrency: 4 }),
      list: Array.from({ length: 20 }, (_, i) => i),
      runItem: h.runItem,
    })

    expect(h.spawned).toHaveLength(20)
    expect(new Set(h.spawned).size).toBe(20)
    expect([...h.spawned].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i),
    )
  })
})
