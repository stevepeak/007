import { describe, expect, test } from 'bun:test'

import { defaultEvalTools, type EvalSampleInput } from './checks'
import { evalInvocation } from './invoke'

// The seam between how a Sample is AUTHORED (input + per-tool settings) and what
// the engine is HANDED (triggerInput / promptVariables / fixtures / toolModes /
// liveReads). Every combination is exercised here because this translation is
// the whole point of the split: before it, the run handler picked between four
// independently-authorable fields and the losing ones failed silently.

const task: EvalSampleInput = { kind: 'task', variables: { text: 'doc' } }
const convo: EvalSampleInput = {
  kind: 'conversation',
  turns: [
    { role: 'user', text: 'what did we agree?' },
    { role: 'assistant', toolCalls: [{ tool: 'search', output: { hits: 1 } }] },
  ],
  variables: { userId: 'u1' },
}

describe('evalInvocation — input', () => {
  test('a task sample sends its variables and no trigger payload', () => {
    const i = evalInvocation(task, defaultEvalTools())
    expect(i.promptVariables).toEqual({ text: 'doc' })
    expect(i.triggerInput).toEqual({})
  })

  test('a conversation sample sends its thread as the trigger messages', () => {
    const i = evalInvocation(convo, defaultEvalTools())
    const messages = (i.triggerInput as { messages: unknown[] }).messages
    expect(messages).toHaveLength(2)
    // The staged tool result rides along as a completed dynamic-tool part, which
    // is what makes the model treat it as retrieval it already did.
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      parts: [{ type: 'dynamic-tool', toolName: 'search', state: 'output-available' }],
    })
    // A conversation agent's system prompt can still interpolate.
    expect(i.promptVariables).toEqual({ userId: 'u1' })
  })

  test('a workflow sample replays its routed payload verbatim', () => {
    const i = evalInvocation(
      { kind: 'trigger', payload: { chatId: 'c1' }, variables: {} },
      defaultEvalTools(),
    )
    expect(i.triggerInput).toEqual({ chatId: 'c1' })
  })
})

describe('evalInvocation — tools', () => {
  test('a pinned tool sends its output as that tool’s fixture', () => {
    const i = evalInvocation(task, {
      fallback: 'mocked',
      byTool: { search: { mode: 'mocked', output: { hits: 3 } } },
    })
    expect(i.fixtures).toEqual({ search: { hits: 3 } })
    expect(i.toolModes).toEqual({ search: 'mocked' })
    expect(i.liveReads).toBe(false)
  })

  test('a mocked tool with nothing pinned sends no fixture — the engine defaults it to {}', () => {
    const i = evalInvocation(task, {
      fallback: 'mocked',
      byTool: { search: { mode: 'mocked' } },
    })
    expect(i.fixtures).toEqual({})
    expect(i.toolModes).toEqual({ search: 'mocked' })
  })

  test('one tool runs live while the rest stay pinned', () => {
    // The whole point of the per-tool split: this sample grades real retrieval
    // AND replays a fixed memory lookup, which no sample-wide mode could say.
    const i = evalInvocation(task, {
      fallback: 'mocked',
      byTool: {
        search: { mode: 'live' },
        memory: { mode: 'mocked', output: { items: [] } },
      },
    })
    expect(i.toolModes).toEqual({ search: 'live', memory: 'mocked' })
    expect(i.fixtures).toEqual({ memory: { items: [] } })
    // The run-wide default stays off: `toolModes` is what turns one tool live.
    expect(i.liveReads).toBe(false)
  })

  test('a live tool’s pinned output is withheld, not deleted', () => {
    // Switching a tool to Live keeps the author's mock on the row so flipping
    // back costs nothing — but the engine must not be handed a fixture for a
    // tool it is about to execute for real.
    const i = evalInvocation(task, {
      fallback: 'mocked',
      byTool: { search: { mode: 'live', output: { hits: 3 } } },
    })
    expect(i.fixtures).toEqual({})
    expect(i.toolModes).toEqual({ search: 'live' })
  })

  test('a row migrated from sample-wide Live asks for real reads by default', () => {
    const i = evalInvocation(task, { fallback: 'live', byTool: {} })
    expect(i.liveReads).toBe(true)
    expect(i.toolModes).toEqual({})
    expect(i.fixtures).toEqual({})
  })
})
