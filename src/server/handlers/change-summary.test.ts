import { describe, expect, test } from 'bun:test'

import type { AgentConfig } from '../../engine/graph'

import { heuristicAgentChangeSummary } from './change-summary'

// The model-free fallback: what a publish's summary says when the host offers no
// model, or the model call failed. Pure, so it's cheap to pin down exactly.

function config(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    modelId: 'test-model',
    prompt: 'You are a costing assistant.',
    userPrompt: 'Cost this dish: ${dish}',
    toolIds: ['search_catalog'],
    maxTurns: 5,
    inputKind: 'task',
    output: { kind: 'text' },
    subAgents: {
      targets: [],
      maxConcurrent: 4,
      maxSpawns: 10,
      allowStopSignal: true,
    },
    ...over,
  } as AgentConfig
}

describe('heuristicAgentChangeSummary', () => {
  test('no previous version reads as the initial one', () => {
    expect(heuristicAgentChangeSummary(null, config())).toEqual({
      short: 'Initial version.',
      long: '',
    })
  })

  test('an identical config reports no change rather than inventing one', () => {
    expect(heuristicAgentChangeSummary(config(), config()).short).toBe(
      'No configuration changes.',
    )
  })

  test('names the fields that moved, sentence-cased', () => {
    const summary = heuristicAgentChangeSummary(
      config(),
      config({ modelId: 'other-model', prompt: 'Be terse.' }),
    )
    expect(summary.short).toBe('Changed the model, edited the prompt.')
  })

  test('counts tools in and out separately', () => {
    const summary = heuristicAgentChangeSummary(
      config({ toolIds: ['a', 'b'] }),
      config({ toolIds: ['b', 'c', 'd'] }),
    )
    expect(summary.short).toBe('Added 2 tools, removed 1 tool.')
  })

  test('a reordered tool list is not a change', () => {
    const summary = heuristicAgentChangeSummary(
      config({ toolIds: ['a', 'b'] }),
      config({ toolIds: ['b', 'a'] }),
    )
    expect(summary.short).toBe('No configuration changes.')
  })

  test('picks up the output contract and delegation, which are nested objects', () => {
    const summary = heuristicAgentChangeSummary(
      config(),
      config({
        output: { kind: 'boolean' },
        subAgents: {
          targets: [{ kind: 'agent', id: 'a1', version: null }],
          maxConcurrent: 4,
          maxSpawns: 10,
          allowStopSignal: true,
        },
      } as Partial<AgentConfig>),
    )
    expect(summary.short).toBe(
      'Changed the output contract, changed delegation.',
    )
  })

  test('the long body stays empty — the heuristic only writes a subject', () => {
    expect(
      heuristicAgentChangeSummary(config(), config({ maxTurns: 9 })).long,
    ).toBe('')
  })
})
