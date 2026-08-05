import { describe, expect, test } from 'bun:test'

import {
  MAX_ROUND_TRIP_MS,
  MAX_TOOL_MS,
  MIN_TOTAL_MS,
  modelBudgetFor,
  STEP_TIMEOUT_SLACK_MS,
} from './model-budget'
import { AI_STEP_OPTS } from '../cloudflare/graph-workflow-dispatch-step-opts'

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
