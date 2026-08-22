import { describe, expect, test } from 'bun:test'

import {
  checkResultSchema,
  checkTreeSchema,
  evalCheckSchema,
  evalSampleInputSchema,
  evalSampleLayer,
  evalToolsSchema,
  isJudgeCheck,
  legacyFreezeTools,
  parseEvalSampleInput,
  parseEvalTools,
  unavailableCheckTypes,
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

  test('a judge is rubric + where to look + who looks — nothing else', () => {
    // The old `bar` / `threshold` / `weight` knobs are gone; a stored one is an
    // unknown key, so zod drops it rather than failing a saved row.
    expect(
      evalCheckSchema.parse({
        type: 'llm_judge',
        rubric: 'x',
        path: 'title',
        modelId: 'm1',
        bar: 'nails_it',
        threshold: 0.7,
        weight: 2,
      }),
    ).toEqual({ type: 'llm_judge', rubric: 'x', path: 'title', modelId: 'm1' })
  })

  test('check tree reduces an op over a list', () => {
    const tree = {
      op: 'or',
      checks: [
        { type: 'tool_called', toolId: 't', called: true },
        { type: 'llm_judge', rubric: 'good', modelId: 'm1' },
      ],
    }
    expect(checkTreeSchema.parse(tree)).toEqual(tree)
    expect(checkTreeSchema.parse(tree).checks.filter(isJudgeCheck)).toHaveLength(
      1,
    )
  })

  test('a sample input is one tagged variant, never a bag of everything', () => {
    expect(evalSampleInputSchema.parse({ kind: 'task' })).toEqual({
      kind: 'task',
      variables: {},
    })
    const convo = {
      kind: 'conversation',
      turns: [{ role: 'user', text: 'hi' }],
      variables: { userId: 'u1' },
    }
    expect(evalSampleInputSchema.parse(convo)).toEqual(convo)
    // The old shape is not a valid input — it has to go through the upgrade.
    expect(() =>
      evalSampleInputSchema.parse({ promptVariables: { a: 'b' } }),
    ).toThrow()
  })

  test('tools are a tri-state; only `mocked` can carry fixtures', () => {
    expect(evalToolsSchema.parse({ mode: 'frozen' })).toEqual({ mode: 'frozen' })
    expect(evalToolsSchema.parse({ mode: 'mocked' })).toEqual({
      mode: 'mocked',
      fixtures: {},
    })
    // The combination that used to be authorable — and silently meaningless.
    expect(evalToolsSchema.parse({ mode: 'frozen', fixtures: { a: 1 } })).toEqual(
      { mode: 'frozen' },
    )
  })
})

// The upgrade every stored row goes through on read. Rows written before the
// split kept four overlapping fields in one column; these are the exact shapes
// that exist in the wild.
describe('legacy row upgrade', () => {
  test('prompt variables become a task input', () => {
    expect(
      parseEvalSampleInput({
        triggerInput: { text: 'doc' },
        promptVariables: { text: 'doc' },
      }),
    ).toEqual({ kind: 'task', variables: { text: 'doc' } })
  })

  test('seeded messages become a conversation input', () => {
    const seeded = [{ role: 'user' as const, text: 'hi' }]
    expect(
      parseEvalSampleInput({ seededMessages: seeded, promptVariables: {} }),
    ).toEqual({ kind: 'conversation', turns: seeded, variables: {} })
  })

  test('a bare routed payload becomes a trigger input', () => {
    expect(parseEvalSampleInput({ triggerInput: { chatId: 'c1' } })).toEqual({
      kind: 'trigger',
      payload: { chatId: 'c1' },
      variables: {},
    })
  })

  test('an empty legacy column is an empty task input', () => {
    expect(parseEvalSampleInput({})).toEqual({ kind: 'task', variables: {} })
  })

  test('an already-upgraded input passes through untouched', () => {
    const input = { kind: 'task' as const, variables: { a: 'b' } }
    expect(parseEvalSampleInput(input)).toEqual(input)
  })

  test('a bare fixtures record becomes mocked tools', () => {
    expect(parseEvalTools({ search: { docs: [] } })).toEqual({
      mode: 'mocked',
      fixtures: { search: { docs: [] } },
    })
  })

  test('the legacy freeze flag wins over the fixtures beside it', () => {
    // It always did — freezing emptied the tool set, so those fixtures were
    // already dead. The upgrade makes that visible instead of silent.
    const legacyInput = { freezeTools: true, promptVariables: {} }
    expect(
      parseEvalTools({ search: { docs: [] } }, legacyFreezeTools(legacyInput)),
    ).toEqual({ mode: 'frozen' })
  })
})

describe('derived sample layer', () => {
  const task = { kind: 'task' as const, variables: {} }
  const convo = { kind: 'conversation' as const, turns: [], variables: {} }

  test('names the layer a sample actually belongs to', () => {
    expect(evalSampleLayer(convo, { mode: 'frozen' })).toBe('synthesis')
    expect(evalSampleLayer(task, { mode: 'live' })).toBe('integration')
    expect(
      evalSampleLayer(task, { mode: 'mocked', fixtures: { s: {} } }),
    ).toBe('trajectory')
    expect(evalSampleLayer(task, { mode: 'mocked', fixtures: {} })).toBe('io')
  })

  test('freezing a task agent is not synthesis — there is nothing staged', () => {
    expect(evalSampleLayer(task, { mode: 'frozen' })).toBe('io')
  })

  test('trajectory checks are unavailable exactly when tools are frozen', () => {
    expect(unavailableCheckTypes({ mode: 'frozen' })).toEqual([
      'tool_called',
      'tool_args_match',
    ])
    expect(unavailableCheckTypes({ mode: 'mocked', fixtures: {} })).toEqual([])
    expect(unavailableCheckTypes({ mode: 'live' })).toEqual([])
  })

  test('check result carries an optional confidence + reason', () => {
    // A binary check has nothing to add to its own pass flag.
    expect(checkResultSchema.parse({ pass: true })).toEqual({ pass: true })
    expect(
      checkResultSchema.parse({ pass: false, confidence: 9, reason: 'nope' }),
    ).toEqual({ pass: false, confidence: 9, reason: 'nope' })
    // Confidence is out of 10, not a 0..1 float.
    expect(() =>
      checkResultSchema.parse({ pass: true, confidence: 11 }),
    ).toThrow()
  })
})
