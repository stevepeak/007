import { describe, expect, test } from 'bun:test'

import type { EvalCheck } from '../../server/protocol'

import {
  describeCheck,
  exampleCheckName,
  heuristicCheckName,
  isUnnamed,
} from './check-naming'

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
  test('prefers the author’s name over anything derived', () => {
    const check: EvalCheck = {
      type: 'tool_called',
      toolId: 'search_statutes',
      called: true,
      label: '  Cites the statute  ',
    }
    expect(describeCheck(check)).toBe('Cites the statute')
    expect(isUnnamed(check)).toBe(false)
  })

  test('an unnamed judge quotes its rubric rather than posing as named', () => {
    const check: EvalCheck = {
      type: 'llm_judge',
      rubric: 'The title should be something mentioning alimony',
    }
    // Quoted, not title-cased: it has to look unfinished in a checklist.
    expect(describeCheck(check)).toBe(
      '“The title should be something mentioning alimony”',
    )
    expect(isUnnamed(check)).toBe(true)
  })

  test('falls back to a plain marker when there is nothing to say', () => {
    expect(describeCheck({ type: 'llm_judge', rubric: '' })).toBe(
      'Unnamed check',
    )
  })
})

describe('exampleCheckName', () => {
  test('varies by position so a list of unnamed checks shows the range', () => {
    expect(exampleCheckName(0)).not.toBe(exampleCheckName(1))
    // Stable for a given index, and defined for any index.
    expect(exampleCheckName(0)).toBe(exampleCheckName(0))
    expect(exampleCheckName(99)).toBeTruthy()
    expect(exampleCheckName(Number.NaN)).toBeTruthy()
  })
})
