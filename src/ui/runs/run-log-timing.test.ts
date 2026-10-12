import { describe, expect, test } from 'bun:test'

import { toolCallDurationLabel, turnDurationLabel } from './run-log-timing'

describe('turnDurationLabel', () => {
  test('a turn recorded before timing existed says nothing', () => {
    expect(turnDurationLabel({ stepNumber: 0, toolCalls: [] })).toBeNull()
  })

  test('names model, thinking and tool time when they were timed', () => {
    expect(
      turnDurationLabel({
        stepNumber: 0,
        toolCalls: [],
        durationMs: 293_000,
        modelMs: 281_000,
        reasoningMs: 190_000,
        toolMs: 12_000,
      }),
    ).toBe('4m 53s · model 4m 41s (thinking 3m 10s) · tools 12s')
  })

  test('an unsplit model call carries no thinking figure', () => {
    expect(
      turnDurationLabel({
        stepNumber: 0,
        toolCalls: [],
        durationMs: 1_500,
        modelMs: 1_500,
      }),
    ).toBe('1.5s · model 1.5s')
  })
})

describe('toolCallDurationLabel', () => {
  const base = { toolCallId: 'a', toolName: 't', input: {}, output: {} }

  test('untimed call → null', () => {
    expect(toolCallDurationLabel(base)).toBeNull()
  })

  test('falls back to the bounds when durationMs is absent', () => {
    expect(
      toolCallDurationLabel({ ...base, startedAt: 1_000, finishedAt: 5_200 }),
    ).toBe('4.2s')
  })

  test('a failed call says so', () => {
    expect(
      toolCallDurationLabel({ ...base, durationMs: 300, failed: true }),
    ).toBe('failed after 300ms')
  })
})
