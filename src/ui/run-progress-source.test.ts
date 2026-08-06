import { describe, expect, test } from 'bun:test'

import { nextPollDelay } from './run-progress-source'

// Fixed "random" so the jitter is deterministic: 0.5 → the 0.8..1.2 multiplier
// lands exactly on 1.0, i.e. the unjittered backoff.
const noJitter = () => 0.5

const opts = { pollMs: 1500, maxBackoffMs: 30_000 }

describe('nextPollDelay', () => {
  test('polls at the steady cadence while nothing is failing', () => {
    expect(nextPollDelay(0, opts, noJitter)).toBe(1500)
  })

  test('backs off exponentially as failures accumulate', () => {
    expect(nextPollDelay(1, opts, noJitter)).toBe(3000)
    expect(nextPollDelay(2, opts, noJitter)).toBe(6000)
    expect(nextPollDelay(3, opts, noJitter)).toBe(12_000)
  })

  test('caps the backoff so a long outage never stops being retried slowly', () => {
    expect(nextPollDelay(20, opts, noJitter)).toBe(30_000)
  })

  test('never returns a delay below the steady cadence, even if the cap is lower', () => {
    // A misconfigured cap must not turn a failing loop into a faster loop —
    // that is exactly the hammer this backoff exists to prevent.
    const tight = { pollMs: 1500, maxBackoffMs: 100 }
    expect(nextPollDelay(1, tight, noJitter)).toBe(1500)
  })

  test('jitters within ±20% so many tabs do not poll in lockstep', () => {
    expect(nextPollDelay(1, opts, () => 0)).toBe(2400)
    expect(nextPollDelay(1, opts, () => 1)).toBe(3600)
  })
})
