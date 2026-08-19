import { describe, expect, test } from 'bun:test'

import type { ToolContextField, ToolOption } from '../../server/protocol'

import {
  contextFieldsFor,
  contextLabelsFor,
  filledContext,
  missingContext,
  requiredContextKeys,
} from './agent-editor-context'

// The rule that decides whether the playground's Run button is disabled.

const FIELDS: ToolContextField[] = [
  { key: 'clientOrgId', label: 'Client' },
  { key: 'chatId', label: 'Chat thread' },
  { key: 'userId', label: 'Acting user' },
]

const tool = (id: string, requiresContext?: string[]): ToolOption => ({
  id,
  name: id,
  description: id,
  kind: 'ai-tool',
  requiresContext,
})

const TOOLS = [
  tool('search', ['clientOrgId']),
  tool('escalate', ['clientOrgId', 'chatId']),
  tool('web', undefined),
]

describe('requiredContextKeys', () => {
  test('only live tools contribute', () => {
    expect(requiredContextKeys(TOOLS, new Set(['search']))).toEqual([
      'clientOrgId',
    ])
    // `escalate` needs a chat thread — but not while it's being simulated.
    expect(requiredContextKeys(TOOLS, new Set(['web']))).toEqual([])
  })

  test('keys are unioned across live tools without duplicates', () => {
    expect(requiredContextKeys(TOOLS, new Set(['search', 'escalate']))).toEqual(
      ['clientOrgId', 'chatId'],
    )
  })
})

describe('contextFieldsFor', () => {
  test('resolves keys to the host fields, in the host order', () => {
    expect(contextFieldsFor(FIELDS, ['chatId', 'clientOrgId'])).toEqual([
      FIELDS[0],
      FIELDS[1],
    ])
  })

  test('drops a key the host never declared', () => {
    expect(contextFieldsFor(FIELDS, ['matterId'])).toEqual([])
  })
})

describe('missingContext / filledContext', () => {
  const fields = contextFieldsFor(FIELDS, ['clientOrgId', 'chatId'])

  test('whitespace is not a value', () => {
    expect(
      missingContext(fields, { clientOrgId: '   ', chatId: 'c1' }).map(
        (f) => f.key,
      ),
    ).toEqual(['clientOrgId'])
  })

  test('nothing missing once both are filled', () => {
    expect(missingContext(fields, { clientOrgId: 'o1', chatId: 'c1' })).toEqual(
      [],
    )
  })

  test('only the required keys go on the wire, trimmed', () => {
    expect(
      filledContext(fields, {
        clientOrgId: ' o1 ',
        chatId: '',
        userId: 'leftover',
      }),
    ).toEqual({ clientOrgId: 'o1' })
  })
})

describe('contextLabelsFor', () => {
  test('labels a tool s requirements for its row chip', () => {
    expect(contextLabelsFor(TOOLS[1], FIELDS)).toEqual([
      'Client',
      'Chat thread',
    ])
  })

  test('an undeclared key shows as its raw key rather than vanishing', () => {
    expect(contextLabelsFor(tool('x', ['matterId']), FIELDS)).toEqual([
      'matterId',
    ])
  })
})
