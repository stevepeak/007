import { describe, expect, test } from 'bun:test'

import { agentConfigSchema } from './agent-config-schema'

// The bounds here are a CONTRACT with the editor, which clamps its inputs to the
// same numbers. When they disagree the failure is ugly and remote from the
// cause: the author types a value the form accepts, and the save fails with a
// raw zod issue array. These tests pin both ends.

const base = {
  modelId: 'mock',
  prompt: 'Do the thing.',
  userPrompt: 'Go.',
  inputKind: 'task' as const,
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
      userPrompt: 'Go.',
      inputKind: 'task' as const,
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

describe('agentConfigSchema — input contract', () => {
  test('defaults to a task agent', () => {
    expect(agentConfigSchema.parse(base).inputKind).toBe('task')
  })

  // The AI SDK throws on a call with no messages, so a task agent that renders
  // no user turn cannot run at all. Rejecting it at save time turns a run-time
  // crash into a form error.
  test('a task agent must carry a user message', () => {
    expect(
      agentConfigSchema.safeParse({ ...base, userPrompt: '' }).success,
    ).toBe(false)
    expect(
      agentConfigSchema.safeParse({ ...base, userPrompt: '   \n ' }).success,
    ).toBe(false)
  })

  // A conversation agent's messages come from the node's binding, so it needs no
  // turn of its own.
  test('a conversation agent may omit the user message', () => {
    const c = agentConfigSchema.parse({
      ...base,
      inputKind: 'conversation',
      userPrompt: '',
    })
    expect(c.inputKind).toBe('conversation')
    expect(c.userPrompt).toBe('')
  })
})

describe('agentConfigSchema — legacy configs', () => {
  // `wf_agent_version` rows are immutable, so every config stored before this
  // contract existed still has to parse — otherwise the agents list blanks and
  // the run manifest aborts. What it CAN'T do is reproduce the old user turn:
  // that was the incoming edge's payload, which lives in the run, not the config.
  const legacy = {
    modelId: 'mock',
    prompt: 'Classify ${title} from ${document}.',
    toolIds: [],
  }

  test('an old config parses, with a turn synthesized from its variables', () => {
    const c = agentConfigSchema.parse(legacy)
    expect(c.inputKind).toBe('task')
    expect(c.userPrompt).toBe('title: ${title}\n\ndocument: ${document}')
  })

  test('acceptsConversation maps onto the conversation kind', () => {
    const c = agentConfigSchema.parse({ ...legacy, acceptsConversation: true })
    expect(c.inputKind).toBe('conversation')
    expect(c.userPrompt).toBe('')
  })
})
