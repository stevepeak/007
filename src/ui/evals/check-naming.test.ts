import { describe, expect, test } from 'bun:test'

import type { EvalCheck } from '../../server/protocol'

import { describeCheck, heuristicCheckName } from './check-naming'

// The naming convention is only worth anything if every derived name actually
// lands in the assertion voice — these lock the voice in, since a regression
// here is invisible until someone reads a checklist full of operator noise.

describe('heuristicCheckName', () => {
  test('names a tool call in third person, both polarities', () => {
    expect(
      heuristicCheckName({
        type: 'tool_called',
        toolId: 'search_statutes',
        called: true,
      }),
    ).toBe('Calls search_statutes')
    expect(
      heuristicCheckName({
        type: 'tool_called',
        toolId: 'send_email',
        called: false,
      }),
    ).toBe('Never calls send_email')
  })

  test('names node visits and output matches', () => {
    expect(
      heuristicCheckName({ type: 'node_visited', nodeId: 'draft', visited: true }),
    ).toBe('Reaches draft')
    expect(
      heuristicCheckName({
        type: 'output_match',
        path: 'title',
        match: 'contains',
        value: 'alimony',
      }),
    ).toBe('Output.title contains “alimony”')
    expect(
      heuristicCheckName({ type: 'output_match', match: 'equals', value: 42 }),
    ).toBe('Output is 42')
  })

  test('declines to name a half-configured check', () => {
    expect(
      heuristicCheckName({ type: 'tool_called', toolId: '', called: true }),
    ).toBeNull()
  })

  test('declines to name a judge — its assertion is prose', () => {
    expect(
      heuristicCheckName({ type: 'llm_judge', rubric: 'Mention the alimony' }),
    ).toBeNull()
  })
})

describe('describeCheck', () => {
  test('summarizes a configured check from its assertion', () => {
    const check: EvalCheck = {
      type: 'tool_called',
      toolId: 'search_statutes',
      called: true,
    }
    expect(describeCheck(check)).toBe('Calls search_statutes')
  })

  test('ignores a stray label left over from when checks had titles', () => {
    // Old rows still carry one in their JSON (and in frozen run snapshots).
    // The summary is derived, always — a title can't override what it says.
    const legacy = {
      type: 'tool_called',
      toolId: 'search_statutes',
      called: true,
      label: 'Cites the statute',
    } as unknown as EvalCheck
    expect(describeCheck(legacy)).toBe('Calls search_statutes')
  })

  test('a judge quotes its rubric — prose, not a name', () => {
    const check: EvalCheck = {
      type: 'llm_judge',
      rubric: 'The title should be something mentioning alimony',
    }
    expect(describeCheck(check)).toBe(
      '“The title should be something mentioning alimony”',
    )
  })

  test('falls back to the type name while a check is still empty', () => {
    expect(describeCheck({ type: 'llm_judge', rubric: '' })).toBe('Judge')
    expect(
      describeCheck({ type: 'tool_called', toolId: '', called: true }),
    ).toBe('Tool called')
  })
})
