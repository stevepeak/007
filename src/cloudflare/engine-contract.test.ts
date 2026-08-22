import { describe, expect, test } from 'bun:test'

import {
  MAX_ROUND_TRIP_MS,
  MIN_TOTAL_MS,
  modelBudgetFor,
  STEP_TIMEOUT_SLACK_MS,
} from '../engine/model-budget'

import { calleeEventType, toCalleeWire } from './callee-protocol'
import { AI_STEP_OPTS } from './graph-workflow-dispatch-step-opts'

// Assertions that genuinely span the engine↔cloudflare seam.
//
// They live HERE, not in `src/engine`, because the dependency rule is one-way:
// cloudflare may import engine, never the reverse. These same three tests used
// to sit in engine/model-budget.test.ts and engine/execution-modes.test.ts
// reaching UP into ../cloudflare — the only two breaches of that rule anywhere
// in src/, and the kind of thing that reads as precedent once it exists. The
// coverage is worth keeping; the direction was what needed fixing.

describe('agent step timeout ↔ model budget', () => {
  test('the shipped agent step timeout leaves a usable budget', () => {
    // Guards the two constants drifting apart: if the step timeout were ever
    // lowered to at-or-below the slack, every agent node would silently collapse
    // to the floor budget.
    expect(AI_STEP_OPTS.timeout).toBeGreaterThan(STEP_TIMEOUT_SLACK_MS)
    const b = modelBudgetFor(AI_STEP_OPTS.timeout)
    expect(b.totalMs).toBeGreaterThan(MIN_TOTAL_MS)
    expect(b.stepMs).toBe(MAX_ROUND_TRIP_MS)
  })
})

describe('callee handshake', () => {
  // A parent can have several durable callees parked at once. Keying the event
  // type on the node id is what stops one node's completion waking a sibling —
  // which would hand that sibling the wrong workflow's output.
  test('each calling node parks on its own event type', () => {
    expect(calleeEventType('a')).not.toBe(calleeEventType('b'))
    expect(calleeEventType('a')).toBe(calleeEventType('a'))
  })

  // `undefined` is what a callee whose Output fizzled out returns. It must
  // survive as a JSON `null` rather than an absent field, or the parent's
  // `JSON.parse` gets an empty string and throws — turning a legitimately
  // empty result into a crash in the caller.
  test('an empty callee result crosses the wire as null', () => {
    const wire = toCalleeWire({ ok: true, output: undefined })
    expect(wire).toEqual({ ok: true, outputJson: 'null' })
    expect(JSON.parse((wire as { outputJson: string }).outputJson)).toBeNull()
  })
})
