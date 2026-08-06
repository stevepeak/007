import { describe, expect, test } from 'bun:test'

import { agentConfigSchema } from './agent-config-schema'

// The bounds here are a CONTRACT with the editor, which clamps its inputs to the
// same numbers. When they disagree the failure is ugly and remote from the
// cause: the author types a value the form accepts, and the save fails with a
// raw zod issue array. These tests pin both ends.

const base = {
  modelId: 'mock',
  prompt: 'Do the thing.',
  toolIds: [],
}

describe('agentConfigSchema — limits', () => {
  test('maxTurns accepts the full range up to 100', () => {
    expect(agentConfigSchema.parse({ ...base, maxTurns: 100 }).maxTurns).toBe(
      100,
    )
    expect(agentConfigSchema.safeParse({ ...base, maxTurns: 101 }).success).toBe(
      false,
    )
    expect(agentConfigSchema.safeParse({ ...base, maxTurns: 0 }).success).toBe(
      false,
    )
  })

  test('a config with no budget parses, and the budget is off', () => {
    const c = agentConfigSchema.parse(base)
    expect(c.toolTokenBudget).toBeNull()
    expect(c.requireToolFirstTurn).toBe(false)
  })

  test('a budget is a single token count, floored so it can do something', () => {
    expect(
      agentConfigSchema.parse({ ...base, toolTokenBudget: 50_000 })
        .toolTokenBudget,
    ).toBe(50_000)
    // Below 1000 there isn't room for a single useful turn — reject rather than
    // accept a budget that trips on turn one every time.
    expect(
      agentConfigSchema.safeParse({ ...base, toolTokenBudget: 10 }).success,
    ).toBe(false)
  })

  test('old stored configs still parse — the new fields are additive', () => {
    // A row written before either field existed. Zod fills both, so an existing
    // published agent keeps behaving exactly as it did.
    const legacy = {
      modelId: 'venice-uncensored',
      prompt: 'Answer the question.',
      toolIds: ['search'],
      maxTurns: 5,
      output: { kind: 'text' as const },
    }
    const c = agentConfigSchema.parse(legacy)
    expect(c.toolTokenBudget).toBeNull()
    expect(c.requireToolFirstTurn).toBe(false)
    expect(c.maxTurns).toBe(5)
  })
})

describe('agentConfigSchema — acceptsConversation', () => {
  // The declaration that makes an agent node's `conversation` input exist. It
  // defaults OFF so a config written before it existed reads as what it is: a
  // step agent that answers its single input, not a chat responder.
  test('defaults to off, and a stored declaration round-trips', () => {
    expect(agentConfigSchema.parse(base).acceptsConversation).toBe(false)
    expect(
      agentConfigSchema.parse({ ...base, acceptsConversation: true })
        .acceptsConversation,
    ).toBe(true)
  })
})
