import { describe, expect, test } from 'bun:test'

import { agentToolCalls, asAgentMeta, countAgentToolCalls } from './cost'

function call(toolName: string, input: unknown = {}, output: unknown = null) {
  return { toolCallId: `id-${toolName}`, toolName, input, output }
}

const meta = {
  model: 'm',
  steps: [
    {
      stepNumber: 0,
      toolCalls: [call('search', { q: 'a' }, 'hit'), call('read')],
    },
    { stepNumber: 1, toolCalls: [call('search', { q: 'b' })] },
    { stepNumber: 2, toolCalls: [] },
  ],
  totalUsage: { inputTokens: 1, outputTokens: 2 },
}

describe('agentToolCalls', () => {
  test('flattens every turn in transcript order', () => {
    expect(agentToolCalls({ meta })).toEqual([
      { toolId: 'search', args: { q: 'a' }, output: 'hit' },
      { toolId: 'read', args: {}, output: null },
      { toolId: 'search', args: { q: 'b' }, output: null },
    ])
  })

  test('reads a transcript recorded without totalUsage', () => {
    const { totalUsage: _, ...partial } = meta
    expect(asAgentMeta(partial)).toBeNull()
    expect(agentToolCalls({ meta: partial })).toHaveLength(3)
  })

  test('is empty for non-agent meta', () => {
    expect(agentToolCalls({ meta: null })).toEqual([])
    expect(agentToolCalls({ meta: { toolId: 'search' } })).toEqual([])
    expect(
      agentToolCalls({ meta: { questionIds: ['q'], usage: {} } }),
    ).toEqual([])
  })
})

describe('countAgentToolCalls', () => {
  test('tallies by tool, most-called first, skipping nameless calls', () => {
    const withNameless = {
      ...meta,
      steps: [...meta.steps, { stepNumber: 3, toolCalls: [call('')] }],
    }
    expect(countAgentToolCalls({ meta: withNameless })).toEqual([
      { toolId: 'search', count: 2 },
      { toolId: 'read', count: 1 },
    ])
  })
})
