import { describe, expect, test } from 'bun:test'

import type { DataField } from './node-io'
import { buildTransformCopilotPrompt } from './transform-copilot-prompt'

// The element shape of `find_or_create_chat`'s `messages` — the motivating case.
const MESSAGE_FIELDS: DataField[] = [
  { key: 'id', label: 'id', path: 'id', type: 'string' },
  {
    key: 'role',
    label: 'role',
    path: 'role',
    type: 'string',
    description: 'user, assistant or firm',
  },
  { key: 'body', label: 'body', path: 'body', type: 'string' },
]

const base = {
  nodeLabel: 'Shape the thread',
  sourceLabel: 'Find Chat · messages',
  sourceFields: MESSAGE_FIELDS,
  sourceType: 'array',
  currentExpression: '',
}

describe('buildTransformCopilotPrompt', () => {
  test('carries the real field names, which is the point of the link', () => {
    const p = buildTransformCopilotPrompt(base)
    expect(p).toContain('Shape the thread')
    expect(p).toContain('Find Chat · messages')
    // Every field, with its type — this is what stops the Copilot guessing.
    expect(p).toContain('id: string')
    expect(p).toContain('role: string — user, assistant or firm')
    expect(p).toContain('body: string')
  })

  test('states the target contract when a shape is declared', () => {
    const p = buildTransformCopilotPrompt({ ...base, outputShape: 'conversation' })
    expect(p).toContain('produce a "conversation"')
    expect(p).toContain('"role": "user", "assistant" or "system"')
    expect(p).toContain('"parts"')
    // The firm→user remap is the trap in this project's data; name it.
    expect(p).toContain('map them onto one of the three')
  })

  test('asks what the output should be when no shape is declared', () => {
    const p = buildTransformCopilotPrompt(base)
    expect(p).toContain('Ask me what the result needs to look like.')
  })

  test('always warns about the single-element collapse', () => {
    const p = buildTransformCopilotPrompt(base)
    expect(p).toContain('[ ... ]` array')
    expect(p).toContain('one-element input silently returns an object')
  })

  test('switches to a fix-this request when an expression already exists', () => {
    const p = buildTransformCopilotPrompt({
      ...base,
      currentExpression: '$.{ "role": role }',
    })
    expect(p).toContain("tell me what's wrong with it")
    expect(p).toContain('$.{ "role": role }')
  })

  test('admits when the shape is unknown instead of showing an empty outline', () => {
    const p = buildTransformCopilotPrompt({
      ...base,
      sourceFields: [],
      sourceType: 'unknown',
      sourceLabel: null,
    })
    expect(p).toContain('cannot determine')
    expect(p).toContain('Ask me for a sample')
    // No fabricated outline.
    expect(p).not.toContain('id: string')
  })

  test('a known container type with no visible fields still asks for a sample', () => {
    const p = buildTransformCopilotPrompt({
      ...base,
      sourceFields: [],
      sourceType: 'array',
    })
    expect(p).toContain('type `array`')
    expect(p).toContain('ask me for a sample')
  })

  test('descends into array element shapes, not just top-level keys', () => {
    const p = buildTransformCopilotPrompt({
      ...base,
      sourceType: 'object',
      sourceFields: [
        {
          key: 'messages',
          label: 'messages',
          path: 'messages',
          type: 'array',
          items: MESSAGE_FIELDS,
        },
      ],
    })
    expect(p).toContain('messages: array')
    // The element fields are what the expression maps over.
    expect(p).toContain('role: string')
  })
})
