import { describe, expect, test } from 'bun:test'

import type { WaitNode } from '../graph'
import { createMemorySink } from '../stream-sink'

import { executeWaitNode, WAIT_POLL_INTERVAL_MS } from './wait'

function waitNode(config: Partial<WaitNode['config']> = {}): WaitNode {
  return {
    id: 'w',
    position: { x: 0, y: 0 },
    label: 'Wait for runs',
    informUser: { mode: 'off' },
    kind: 'wait',
    config: {
      runIds: { kind: 'ref', nodeId: 'src', path: 'ids' },
      timeoutMs: 60_000,
      onTimeout: 'continue',
      ...config,
    },
  }
}

const outputs = (ids: unknown) => new Map<string, unknown>([['src', { ids }]])

// Each read returns the next snapshot of statuses, then repeats the last.
function statusSequence(snapshots: Record<string, string>[]) {
  let reads = 0
  return {
    reads: () => reads,
    getRunStatuses: (ids: string[]) => {
      const snap = snapshots[Math.min(reads, snapshots.length - 1)]
      reads++
      return Promise.resolve(
        new Map(
          ids
            .filter((id) => snap[id] !== undefined)
            .map((id) => [id, { status: snap[id] }]),
        ),
      )
    },
  }
}

// A fake clock: `sleep` advances it instead of waiting.
function fakeClock() {
  let t = 0
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms
      return Promise.resolve()
    },
  }
}

describe('wait node', () => {
  test('no runs to wait for continues immediately, without a read', async () => {
    const s = statusSequence([{}])
    const r = await executeWaitNode({
      node: waitNode(),
      nodeOutputs: outputs([]),
      getRunStatuses: s.getRunStatuses,
    })
    expect(r.output).toMatchObject({ satisfied: true, total: 0 })
    expect(s.reads()).toBe(0)
  })

  test('an unbound list is the same as an empty one', async () => {
    const r = await executeWaitNode({
      node: waitNode({ runIds: undefined }),
      nodeOutputs: new Map(),
    })
    expect(r.output.satisfied).toBe(true)
  })

  test('re-reads until every run has finished', async () => {
    const s = statusSequence([
      { a: 'running', b: 'queued' },
      { a: 'completed', b: 'running' },
      { a: 'completed', b: 'failed' },
    ])
    const r = await executeWaitNode({
      node: waitNode(),
      nodeOutputs: outputs(['a', 'b']),
      getRunStatuses: s.getRunStatuses,
      ...fakeClock(),
    })
    expect(r.output).toMatchObject({
      satisfied: true,
      total: 2,
      done: 2,
      pending: [],
      waitedMs: 2 * WAIT_POLL_INTERVAL_MS,
    })
  })

  test('a run answered but still draining (`done`) counts as finished', async () => {
    const s = statusSequence([{ a: 'done' }])
    const r = await executeWaitNode({
      node: waitNode(),
      nodeOutputs: outputs(['a']),
      getRunStatuses: s.getRunStatuses,
    })
    expect(r.output.satisfied).toBe(true)
  })

  test('a run with no row is not waited on', async () => {
    const s = statusSequence([{ a: 'completed' }])
    const r = await executeWaitNode({
      node: waitNode(),
      nodeOutputs: outputs(['a', 'gone']),
      getRunStatuses: s.getRunStatuses,
    })
    expect(r.output).toMatchObject({ satisfied: true, total: 2, done: 2 })
  })

  test('runs out of time with satisfied: false and the runs still pending', async () => {
    const s = statusSequence([{ a: 'completed', b: 'running' }])
    const r = await executeWaitNode({
      node: waitNode({ timeoutMs: 3 * WAIT_POLL_INTERVAL_MS }),
      nodeOutputs: outputs(['a', 'b']),
      getRunStatuses: s.getRunStatuses,
      ...fakeClock(),
    })
    expect(r.output).toMatchObject({
      satisfied: false,
      done: 1,
      pending: ['b'],
    })
    expect(r.output.waitedMs).toBeLessThanOrEqual(3 * WAIT_POLL_INTERVAL_MS)
  })

  test('onTimeout: fail fails the node', async () => {
    const s = statusSequence([{ a: 'running' }])
    const run = executeWaitNode({
      node: waitNode({ timeoutMs: WAIT_POLL_INTERVAL_MS, onTimeout: 'fail' }),
      nodeOutputs: outputs(['a']),
      getRunStatuses: s.getRunStatuses,
      ...fakeClock(),
    })
    expect(run).rejects.toThrow('1 of 1 runs unfinished')
  })

  test('a tighter backend budget ends the wait first', async () => {
    const s = statusSequence([{ a: 'running' }])
    const r = await executeWaitNode({
      node: waitNode({ timeoutMs: 60_000 }),
      nodeOutputs: outputs(['a']),
      getRunStatuses: s.getRunStatuses,
      budgetMs: 2 * WAIT_POLL_INTERVAL_MS,
      ...fakeClock(),
    })
    expect(r.output.satisfied).toBe(false)
    expect(s.reads()).toBe(3)
  })

  test('emits a progress line each time a run finishes', async () => {
    const s = statusSequence([
      { a: 'running', b: 'running' },
      { a: 'running', b: 'running' },
      { a: 'completed', b: 'running' },
      { a: 'completed', b: 'completed' },
    ])
    const sink = createMemorySink()
    await executeWaitNode({
      node: waitNode({ progress: '${done} of ${total} ready' }),
      nodeOutputs: outputs(['a', 'b']),
      getRunStatuses: s.getRunStatuses,
      sink,
      ...fakeClock(),
    })
    const lines = sink.logs
      .filter((e) => e.level === 'progress')
      .map((e) => e.message)
    // Nothing once everything has finished: the wait is over.
    expect(lines).toEqual(['0 of 2 ready', '1 of 2 ready'])
  })

  test('a cancelled run stops waiting', async () => {
    const s = statusSequence([{ a: 'running' }])
    const r = await executeWaitNode({
      node: waitNode(),
      nodeOutputs: outputs(['a']),
      getRunStatuses: s.getRunStatuses,
      isCancelled: () => Promise.resolve(true),
      ...fakeClock(),
    })
    expect(r.output.satisfied).toBe(false)
    expect(s.reads()).toBe(1)
  })

  test('under simulate, nothing is waited on', async () => {
    const s = statusSequence([{ a: 'running' }])
    const r = await executeWaitNode({
      node: waitNode(),
      nodeOutputs: outputs(['a']),
      getRunStatuses: s.getRunStatuses,
      simulate: true,
    })
    expect(r.output.satisfied).toBe(true)
    expect(s.reads()).toBe(0)
  })

  test('a non-list binding is an authoring error', async () => {
    const run = executeWaitNode({
      node: waitNode(),
      nodeOutputs: outputs('a'),
    })
    expect(run).rejects.toThrow('must resolve to a list')
  })

  test('a host that cannot read runs fails loudly when there is something to wait on', async () => {
    const run = executeWaitNode({
      node: waitNode(),
      nodeOutputs: outputs(['a']),
    })
    expect(run).rejects.toThrow('cannot read run status')
  })
})
