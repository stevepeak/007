import { describe, expect, test } from 'bun:test'

import {
  checkResultSchema,
  checkTreeSchema,
  evalCheckSchema,
  evalInitialConditionSchema,
  isJudgeCheck,
} from './checks'

// Phase 2 — the shared check vocabulary. These pure zod schemas are validated at
// the data-access boundary (on every row upsert) and reused by the Phase 3
// grader, so their shape is load-bearing. No DB, no engine.

describe('eval checks schema', () => {
  test('accepts each binary check type', () => {
    for (const check of [
      { type: 'tool_called', toolId: 'issue_refund', called: true },
      {
        type: 'tool_args_match',
        toolId: 'issue_refund',
        path: 'amount',
        match: 'equals',
        value: 100,
      },
      { type: 'node_visited', nodeId: 'ask_order_id', visited: false },
      {
        type: 'node_input_match',
        nodeId: 'ask_order_id',
        match: 'contains',
        value: 'missing id',
      },
      { type: 'output_match', match: 'regex', value: 'ETA' },
    ]) {
      expect(evalCheckSchema.parse(check)).toEqual(check)
    }
  })

  test('accepts a judge check and applies no defaults (optional stay absent)', () => {
    const judge = { type: 'llm_judge', rubric: 'asks politely' }
    const parsed = evalCheckSchema.parse(judge)
    expect(parsed).toEqual(judge)
    expect(isJudgeCheck(parsed)).toBe(true)
  })

  test('rejects an unknown check type', () => {
    expect(() =>
      evalCheckSchema.parse({ type: 'telepathy', vibes: 'good' }),
    ).toThrow()
  })

  test('rejects a judge threshold out of 0..1', () => {
    expect(() =>
      evalCheckSchema.parse({
        type: 'llm_judge',
        rubric: 'x',
        threshold: 1.5,
      }),
    ).toThrow()
  })

  test('check tree reduces an op over a list', () => {
    const tree = {
      op: 'or',
      checks: [
        { type: 'tool_called', toolId: 't', called: true },
        { type: 'llm_judge', rubric: 'good', threshold: 0.7, weight: 2 },
      ],
    }
    expect(checkTreeSchema.parse(tree)).toEqual(tree)
    expect(checkTreeSchema.parse(tree).checks.filter(isJudgeCheck)).toHaveLength(
      1,
    )
  })

  test('initial condition is fully optional', () => {
    expect(evalInitialConditionSchema.parse({})).toEqual({})
    const full = {
      triggerInput: { chatId: 'c1', messages: [] },
      promptVariables: { userId: 'u1' },
    }
    expect(evalInitialConditionSchema.parse(full)).toEqual(full)
  })

  test('check result carries an optional score + reason', () => {
    expect(checkResultSchema.parse({ pass: true })).toEqual({ pass: true })
    expect(
      checkResultSchema.parse({ pass: false, score: 0.55, reason: 'nope' }),
    ).toEqual({ pass: false, score: 0.55, reason: 'nope' })
  })
})
