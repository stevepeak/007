import { describe, expect, test } from 'bun:test'

import { buildAgentSchemaCopilotPrompt } from './agent-schema-copilot-prompt'

const base = {
  agentName: 'Intake Triage',
  agentDescription: 'Sorts inbound client email into a matter and a priority.',
  instructions: 'Read the message and decide which matter it belongs to.',
  toolNames: ['search_knowledge_base', 'read_client_memory'],
  currentSource: '',
}

describe('buildAgentSchemaCopilotPrompt', () => {
  test('carries the agent context the author would otherwise have to retype', () => {
    const p = buildAgentSchemaCopilotPrompt(base)
    expect(p).toContain('Intake Triage')
    expect(p).toContain('Sorts inbound client email')
    expect(p).toContain('Read the message and decide which matter')
    expect(p).toContain('search_knowledge_base, read_client_memory')
  })

  // The whole point of this variant: hand the turn back rather than guessing.
  test('asks the author what they want before writing anything', () => {
    const p = buildAgentSchemaCopilotPrompt(base)
    expect(p).toContain('Before writing anything: ask me what the result needs')
    expect(p).toContain('how it will be used downstream')
  })

  test('switches to a change conversation when a schema already exists', () => {
    const p = buildAgentSchemaCopilotPrompt({
      ...base,
      currentSource: 'z.object({ matterId: z.string() })',
    })
    expect(p).toContain('Help me change the structured output schema')
    expect(p).toContain('It currently returns:')
    expect(p).toContain('z.object({ matterId: z.string() })')
    expect(p).toContain('ask me what I want changed')
  })

  test('states the dialect limits so the answer actually compiles', () => {
    const p = buildAgentSchemaCopilotPrompt(base)
    expect(p).toContain('z.enum([…])')
    expect(p).toContain('.optional()')
    // The compiler parses rather than executes, so these are genuinely absent.
    expect(p).toContain('No refinements, transforms, unions, records')
    expect(p).toContain('parsed rather than executed')
  })

  test('names the toolless and instructionless cases instead of staying silent', () => {
    const p = buildAgentSchemaCopilotPrompt({
      ...base,
      instructions: '   ',
      toolNames: [],
      agentDescription: '',
    })
    expect(p).toContain('no instructions written yet')
    expect(p).toContain('calls no tools')
    expect(p).not.toContain("What it's for:")
  })

  test('truncates very long instructions rather than flooding the composer', () => {
    const p = buildAgentSchemaCopilotPrompt({
      ...base,
      instructions: 'x'.repeat(5000),
    })
    expect(p).toContain('…(truncated)')
    expect(p.length).toBeLessThan(3000)
  })

  test('mentions .describe() — the agent reads those, so they do real work', () => {
    const p = buildAgentSchemaCopilotPrompt(base)
    expect(p).toContain('.describe("…") on each field')
  })
})
