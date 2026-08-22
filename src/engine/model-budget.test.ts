import { describe, expect, test } from 'bun:test'

import {
  MAX_ROUND_TRIP_MS,
  MAX_TOOL_MS,
  MIN_TOTAL_MS,
  modelBudgetFor,
  remainingBudget,
  STEP_TIMEOUT_SLACK_MS,
} from './model-budget'
import { defaultNodeTimeoutMs } from './node-timeout'

describe('modelBudgetFor', () => {
  test('leaves slack below the step timeout so the in-process abort wins', () => {
    const stepTimeoutMs = 20 * 60_000
    const b = modelBudgetFor(stepTimeoutMs)
    expect(b.totalMs).toBe(stepTimeoutMs - STEP_TIMEOUT_SLACK_MS)
    expect(b.totalMs).toBeLessThan(stepTimeoutMs)
  })

  test('caps a round-trip and a tool call rather than scaling them', () => {
    // A generous node budget must not imply that one round-trip may eat it.
    const b = modelBudgetFor(60 * 60_000)
    expect(b.stepMs).toBe(MAX_ROUND_TRIP_MS)
    expect(b.toolMs).toBe(MAX_TOOL_MS)
  })

  // The failure mode this guards: a node pinned to a short `execution.timeoutMs`
  // against sub-budgets larger than itself would never fire them in time, and
  // Cloudflare's external kill — the silent one — would win again.
  test('a node with a short execution.timeoutMs gets sub-budgets under its total', () => {
    const b = modelBudgetFor(45_000)
    expect(b.totalMs).toBe(MIN_TOTAL_MS)
    expect(b.stepMs).toBeLessThanOrEqual(b.totalMs)
    expect(b.toolMs).toBeLessThanOrEqual(b.totalMs)
  })

  test('never returns a zero or negative budget', () => {
    for (const ms of [0, 1_000, STEP_TIMEOUT_SLACK_MS]) {
      const b = modelBudgetFor(ms)
      expect(b.totalMs).toBeGreaterThan(0)
      expect(b.stepMs).toBeGreaterThan(0)
      expect(b.toolMs).toBeGreaterThan(0)
    }
  })

  // The chain that actually broke: the container's kind default feeds
  // `modelBudgetFor`, so a container defaulted to 60s collapses every agent in
  // its subgraph to the floor. Asserted end-to-end rather than on the constant,
  // because the constant was never wrong — the kind list was.
  test('a subgraph container derives a real budget, not the floor', () => {
    for (const kind of ['iteration', 'workflow']) {
      const b = modelBudgetFor(defaultNodeTimeoutMs(kind))
      expect(b.totalMs).toBeGreaterThan(MIN_TOTAL_MS)
    }
  })
})

// A container's budget bounds the whole subgraph, so it is spent DOWN node by
// node. Reissuing it in full is what would let a five-agent item outlive the
// `iter:` step that wraps it and get killed from outside, silently.
describe('remainingBudget', () => {
  test('shrinks the total and re-caps the sub-budgets under it', () => {
    const container = modelBudgetFor(20 * 60_000)
    const left = remainingBudget(container, container.totalMs - 10_000)
    expect(left.totalMs).toBe(10_000)
    expect(left.stepMs).toBe(10_000)
    expect(left.toolMs).toBe(10_000)
  })

  test('leaves generous sub-budgets alone while there is room', () => {
    const container = modelBudgetFor(20 * 60_000)
    const left = remainingBudget(container, 1_000)
    expect(left.totalMs).toBe(container.totalMs - 1_000)
    expect(left.stepMs).toBe(container.stepMs)
    expect(left.toolMs).toBe(container.toolMs)
  })

  // NOT floored to `MIN_TOTAL_MS`, unlike `modelBudgetFor`: a floor here would
  // hand out time the container does not have. The caller reports exhaustion.
  test('goes non-positive once the container is spent', () => {
    const container = modelBudgetFor(20 * 60_000)
    expect(
      remainingBudget(container, container.totalMs + 1).totalMs,
    ).toBeLessThan(0)
  })
})
