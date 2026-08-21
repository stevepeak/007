import { describe, expect, test } from 'bun:test'

import type { EvalSampleInput } from './checks'
import { evalInvocation } from './invoke'

// The seam between how a Sample is AUTHORED (input + tools) and what the engine
// is HANDED (triggerInput / promptVariables / fixtures / freezeTools /
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
    const i = evalInvocation(task, { mode: 'mocked', fixtures: {} })
    expect(i.promptVariables).toEqual({ text: 'doc' })
    expect(i.triggerInput).toEqual({})
  })

  test('a conversation sample sends its thread as the trigger messages', () => {
    const i = evalInvocation(convo, { mode: 'frozen' })
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
      { mode: 'mocked', fixtures: {} },
    )
    expect(i.triggerInput).toEqual({ chatId: 'c1' })
  })
})

describe('evalInvocation — tools', () => {
  test('mocked passes the fixtures through and leaves both flags off', () => {
    const i = evalInvocation(task, {
      mode: 'mocked',
      fixtures: { search: { hits: 3 } },
    })
    expect(i.fixtures).toEqual({ search: { hits: 3 } })
    expect(i.freezeTools).toBe(false)
    expect(i.liveReads).toBe(false)
  })

  test('frozen sends no fixtures — nothing is left to return them', () => {
    const i = evalInvocation(convo, { mode: 'frozen' })
    expect(i.freezeTools).toBe(true)
    expect(i.fixtures).toEqual({})
    expect(i.liveReads).toBe(false)
  })

  test('live asks for real reads and, likewise, sends no fixtures', () => {
    const i = evalInvocation(task, { mode: 'live' })
    expect(i.liveReads).toBe(true)
    expect(i.freezeTools).toBe(false)
    expect(i.fixtures).toEqual({})
  })
})
