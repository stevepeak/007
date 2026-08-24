import { describe, expect, test } from 'bun:test'

import type { WfChangeDTO } from '../../server/protocol'

import { changeActor, changeSummary, changeVerb } from './change-summary'

function change(over: Partial<WfChangeDTO> = {}): WfChangeDTO {
  return {
    id: 'c1',
    entityKind: 'agent',
    entityId: 'a1',
    parentId: null,
    action: 'update',
    fields: [],
    before: null,
    after: null,
    truncated: false,
    actorId: 'user_steve',
    source: 'ui',
    note: null,
    createdAt: 0,
    ...over,
  }
}

describe('changeVerb', () => {
  test('names each action', () => {
    expect(changeVerb(change({ action: 'create' }))).toBe('created')
    expect(changeVerb(change({ action: 'publish' }))).toBe('published')
    expect(changeVerb(change({ action: 'archive' }))).toBe('archived')
    expect(changeVerb(change({ action: 'enable' }))).toBe('enabled')
    expect(changeVerb(change({ action: 'update' }))).toBe('edited')
  })

  // A draft save could not have affected any run; editing a published thing
  // could. Collapsing them would lose the distinction that matters most.
  test('distinguishes a draft save from an edit', () => {
    expect(changeVerb(change({ action: 'update', fields: ['draft'] }))).toBe(
      'saved a draft of',
    )
  })
})

describe('changeSummary', () => {
  test('names the fields that moved', () => {
    expect(
      changeSummary(
        change({ action: 'publish', fields: ['model', 'system prompt'] }),
      ),
    ).toBe('published agent — model, system prompt')
  })

  test('uses the noun a person would use', () => {
    expect(changeSummary(change({ entityKind: 'eval_row' }))).toBe('edited sample')
    expect(changeSummary(change({ entityKind: 'eval_set' }))).toBe('edited goal')
  })

  // The verb already says "draft"; repeating it in the field list is noise.
  test('does not repeat draft in the field list', () => {
    expect(changeSummary(change({ fields: ['draft'] }))).toBe(
      'saved a draft of agent',
    )
  })

  test('omits the placeholder field on a first version', () => {
    expect(
      changeSummary(change({ action: 'publish', fields: ['initial'] })),
    ).toBe('published agent')
  })
})

describe('changeActor', () => {
  test('credits the user who made the change', () => {
    expect(changeActor(change())).toBe('user_steve')
  })

  test('credits the import rather than whoever ran it', () => {
    expect(changeActor(change({ source: 'spec-import' }))).toBe('spec import')
  })

  // Never claim a change was anonymous when the log simply has no name for it.
  test('says unknown rather than inventing an actor', () => {
    expect(changeActor(change({ actorId: null }))).toBe('unknown')
  })
})
