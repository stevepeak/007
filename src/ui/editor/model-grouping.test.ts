import { describe, expect, it } from 'bun:test'

import type { DecisionModelOption, DecisionProvider } from '../../engine'

import { groupModelsByProvider } from './model-grouping'

describe('groupModelsByProvider', () => {
  const providers: DecisionProvider[] = [
    { id: 'a', label: 'Alpha', kind: 'native' },
    { id: 'b', label: 'Beta', kind: 'chat-emulated' },
    { id: 'c', label: 'Empty', kind: 'custom' },
  ]

  it('groups in declared provider order and drops empty providers', () => {
    const models: DecisionModelOption[] = [
      { id: 'b:1', label: 'B1', providerId: 'b' },
      { id: 'a:1', label: 'A1', providerId: 'a' },
    ]
    const groups = groupModelsByProvider(models, providers)
    expect(groups.map((g) => g.provider.id)).toEqual(['a', 'b'])
    expect(groups[1]?.provider.kind).toBe('chat-emulated')
  })

  it('collects models with a missing or unknown provider under "Other"', () => {
    const models: DecisionModelOption[] = [
      { id: 'a:1', label: 'A1', providerId: 'a' },
      { id: 'x:1', label: 'X1', providerId: 'gone' },
      { id: 'bare', label: 'Bare' },
    ]
    const groups = groupModelsByProvider(models, providers)
    const last = groups.at(-1)
    expect(last?.provider).toEqual({
      id: '__ungrouped__',
      label: 'Other',
      kind: 'custom',
    })
    expect(last?.models.map((m) => m.id)).toEqual(['x:1', 'bare'])
  })

  it('names the single group "Models" when no provider is declared', () => {
    const none: DecisionProvider[] = []
    const groups = groupModelsByProvider([{ id: 'm', label: 'M' }], none)
    expect(groups.map((g) => g.provider.label)).toEqual(['Models'])
  })
})
