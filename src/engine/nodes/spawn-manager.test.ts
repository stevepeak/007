import { describe, expect, test } from 'bun:test'

import type { SubAgentTarget } from '../graph'

import {
  type RunSubAgent,
  SpawnManager,
  type SpawnAccepted,
  type SpawnRunResult,
} from './spawn-manager'

// Deterministic tests for the delegation SpawnManager: replay-stable ids, the
// total-spawns cap, the concurrency bound, and the join semantics — in
// particular the stop-signal short-circuit.

const AGENT: SubAgentTarget = { kind: 'agent', id: 'researcher', version: null }

const tick = () => new Promise((r) => setTimeout(r, 0))

// A controllable `runSubAgent`: each sub-run parks until the test resolves its
// gate by ordinal, so we can drive concurrency and completion order by hand.
function controlled() {
  const gates = new Map<number, (r: SpawnRunResult) => void>()
  const active = { current: 0, peak: 0 }
  const runSubAgent: RunSubAgent = (_target, _input, ordinal) => {
    active.current++
    active.peak = Math.max(active.peak, active.current)
    return new Promise<SpawnRunResult>((resolve) => {
      gates.set(ordinal, (r) => {
        active.current--
        resolve(r)
      })
    })
  }
  return { runSubAgent, gates, active }
}

describe('SpawnManager', () => {
  test('spawn is non-blocking and mints replay-stable ids', () => {
    const { runSubAgent } = controlled()
    const m = new SpawnManager({ maxConcurrent: 4, maxSpawns: 10, runSubAgent })
    const a = m.spawn(AGENT, { message: 'a' }) as SpawnAccepted
    const b = m.spawn(AGENT, { message: 'b' }) as SpawnAccepted
    expect(a.spawnId).toBe('spawn-0')
    expect(b.spawnId).toBe('spawn-1')
    expect(a.target).toEqual({ kind: 'agent', id: 'researcher' })
  })

  test('enforces the total-spawns cap with an error object (no throw)', () => {
    const { runSubAgent } = controlled()
    const m = new SpawnManager({ maxConcurrent: 5, maxSpawns: 2, runSubAgent })
    expect('spawnId' in m.spawn(AGENT, {})).toBe(true)
    expect('spawnId' in m.spawn(AGENT, {})).toBe(true)
    const third = m.spawn(AGENT, {})
    expect('error' in third).toBe(true)
  })

  test('bounds concurrency to maxConcurrent', async () => {
    const { runSubAgent, gates, active } = controlled()
    const m = new SpawnManager({ maxConcurrent: 2, maxSpawns: 10, runSubAgent })
    for (let i = 0; i < 5; i++) m.spawn(AGENT, { message: `m${i}` })
    await tick()
    // Only 2 running; the rest queue on the semaphore.
    expect(active.peak).toBe(2)
    expect(gates.size).toBe(2)
    // Free one slot → exactly one queued sub-run starts.
    gates.get(0)!({ output: 'r0', stopSignalled: false })
    await tick()
    expect(active.peak).toBe(2)
    expect(gates.has(2)).toBe(true)
  })

  test('join waits for ALL spawns, then reports them completed', async () => {
    const { runSubAgent, gates } = controlled()
    const m = new SpawnManager({ maxConcurrent: 5, maxSpawns: 10, runSubAgent })
    m.spawn(AGENT, {})
    m.spawn(AGENT, {})
    const joinP = m.join()
    await tick()
    let done = false
    void joinP.then(() => {
      done = true
    })
    gates.get(0)!({ output: 'x', stopSignalled: false })
    await tick()
    // One still running → join has not resolved.
    expect(done).toBe(false)
    gates.get(1)!({ output: 'y', stopSignalled: false })
    const res = await joinP
    expect(res.stopped).toBe(false)
    expect(res.pending).toHaveLength(0)
    expect(res.completed.map((c) => c.output).sort()).toEqual(['x', 'y'])
  })

  test('a stop signal short-circuits the join, leaving the rest pending', async () => {
    const { runSubAgent, gates } = controlled()
    const m = new SpawnManager({ maxConcurrent: 3, maxSpawns: 10, runSubAgent })
    m.spawn(AGENT, { message: 'a' })
    m.spawn(AGENT, { message: 'b' })
    m.spawn(AGENT, { message: 'c' })
    const joinP = m.join()
    await tick()
    // spawn-1 finishes first WITH a stop signal.
    gates.get(1)!({ output: 'eureka', stopSignalled: true, reason: 'found it' })
    const res = await joinP
    expect(res.stopped).toBe(true)
    const stopped = res.completed.find((c) => c.spawnId === 'spawn-1')
    expect(stopped?.stopSignalled).toBe(true)
    expect(stopped?.reason).toBe('found it')
    expect(res.pending.map((p) => p.spawnId).sort()).toEqual([
      'spawn-0',
      'spawn-2',
    ])
  })

  test('join(subset) only waits for the given handles', async () => {
    const { runSubAgent, gates } = controlled()
    const m = new SpawnManager({ maxConcurrent: 5, maxSpawns: 10, runSubAgent })
    m.spawn(AGENT, {}) // spawn-0
    m.spawn(AGENT, {}) // spawn-1 — never resolved
    const joinP = m.join(['spawn-0'])
    await tick()
    gates.get(0)!({ output: 'x', stopSignalled: false })
    const res = await joinP
    expect(res.completed.map((c) => c.spawnId)).toEqual(['spawn-0'])
    expect(res.pending).toHaveLength(0)
    expect(res.stopped).toBe(false)
  })

  test('a thrown sub-run is reported failed, not rejected', async () => {
    const runSubAgent: RunSubAgent = () =>
      Promise.reject(new Error('kaboom'))
    const m = new SpawnManager({ maxConcurrent: 2, maxSpawns: 10, runSubAgent })
    m.spawn(AGENT, {})
    const res = await m.join()
    expect(res.completed[0]?.status).toBe('failed')
    expect(res.completed[0]?.error).toBe('kaboom')
  })

  test('check() is a non-blocking status snapshot', async () => {
    const { runSubAgent, gates } = controlled()
    const m = new SpawnManager({ maxConcurrent: 5, maxSpawns: 10, runSubAgent })
    m.spawn(AGENT, {})
    m.spawn(AGENT, {})
    await tick()
    expect(m.check().every((c) => c.status === 'running')).toBe(true)
    gates.get(0)!({ output: 'x', stopSignalled: false })
    await tick()
    const snap = m.check()
    expect(snap.find((c) => c.spawnId === 'spawn-0')?.status).toBe('completed')
    expect(snap.find((c) => c.spawnId === 'spawn-1')?.status).toBe('running')
  })
})
