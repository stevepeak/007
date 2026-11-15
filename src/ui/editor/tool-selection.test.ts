import { describe, expect, test } from 'bun:test'

import {
  attachedGroups,
  groupDefault,
  detachGroup,
  groupTools,
  nameInGroup,
  setGroupDefault,
  setToolState,
  toolState,
  type ToolSelection,
} from './tool-selection'

const EMPTY: ToolSelection = {
  toolIds: [],
  deferredToolIds: [],
  disabledToolIds: [],
}

const attached = setGroupDefault(EMPTY, 'mcp:acme', 'available')

describe('tool selection', () => {
  test('attaching a connector makes its tools available, not in context', () => {
    expect(attached).toEqual({
      toolIds: ['mcp:acme:*'],
      deferredToolIds: ['mcp:acme:*'],
      disabledToolIds: [],
    })
    expect(toolState(attached, 'mcp:acme:post')).toBe('available')
  })

  test('a tool set apart from the default is recorded as an exception', () => {
    const ctx = setToolState(attached, 'mcp:acme:post', 'context')
    expect(ctx.toolIds).toEqual(['mcp:acme:*', 'mcp:acme:post'])
    expect(toolState(ctx, 'mcp:acme:post')).toBe('context')

    const off = setToolState(attached, 'mcp:acme:delete', 'off')
    expect(off.disabledToolIds).toEqual(['mcp:acme:delete'])
    expect(toolState(off, 'mcp:acme:delete')).toBe('off')
  })

  test('setting a tool back to the default drops the exception', () => {
    const ctx = setToolState(attached, 'mcp:acme:post', 'context')
    expect(setToolState(ctx, 'mcp:acme:post', 'available')).toEqual(attached)
  })

  // Only a couple of tools: default off, two picked.
  test('a default-off connector stays attached through its picked tools', () => {
    const one = setToolState(
      setGroupDefault(attached, 'mcp:acme', 'off'),
      'mcp:acme:post',
      'context',
    )
    expect(one.toolIds).toEqual(['mcp:acme:post'])
    expect(groupDefault(one, 'mcp:acme')).toBe('off')
    expect(toolState(one, 'mcp:acme:other')).toBe('off')
    expect(attachedGroups(one)).toEqual(['mcp:acme'])
  })

  test('changing the default drops exceptions that now match it', () => {
    const sel = setToolState(attached, 'mcp:acme:post', 'context')
    const next = setGroupDefault(sel, 'mcp:acme', 'context')
    expect(next).toEqual({
      toolIds: ['mcp:acme:*'],
      deferredToolIds: [],
      disabledToolIds: [],
    })
  })

  test('a plain tool set off is removed', () => {
    const sel = setToolState(EMPTY, 'lookup', 'context')
    expect(sel.toolIds).toEqual(['lookup'])
    expect(setToolState(sel, 'lookup', 'off')).toEqual(EMPTY)
  })

  test('detaching a connector removes every trace of it', () => {
    let sel = setToolState(attached, 'mcp:acme:post', 'context')
    sel = setToolState(sel, 'mcp:acme:delete', 'off')
    sel = setToolState(sel, 'lookup', 'context')
    expect(detachGroup(sel, 'mcp:acme')).toEqual({
      toolIds: ['lookup'],
      deferredToolIds: [],
      disabledToolIds: [],
    })
  })
})

describe('groupTools', () => {
  const tool = (id: string, name: string, groupLabel?: string) => {
    return {
      id,
      name,
      groupLabel,
      description: '',
      kind: 'ai-tool',
      origin: 'host',
    } as const
  }

  test('splits plain tools from one group per connector', () => {
    const { plain, groups } = groupTools([
      tool('lookup', 'Lookup'),
      tool('mcp:acme:post', 'Acme: Post', 'Acme'),
      tool('mcp:acme:list', 'Acme: List', 'Acme'),
    ])
    expect(plain.map((t) => t.id)).toEqual(['lookup'])
    expect(groups.map((g) => [g.label, g.tools.length])).toEqual([['Acme', 2]])
    expect(nameInGroup(groups[0].tools[0], groups[0])).toBe('Post')
  })

  test('groups host tools registered as <group>:<name>', () => {
    const { plain, groups } = groupTools([
      tool('app:list_tags', 'List tags', 'Acme Co'),
      tool('app:create_tag', 'Create tag', 'Acme Co'),
      tool('mcp:acme:post', 'Acme: Post', 'Acme'),
    ])
    expect(plain).toEqual([])
    expect(groups.map((g) => [g.id, g.label, g.tools.length])).toEqual([
      ['app', 'Acme Co', 2],
      ['mcp:acme', 'Acme', 1],
    ])
  })

  test('a host group attaches whole like a connector', () => {
    const sel = setGroupDefault(EMPTY, 'app', 'available')
    expect(sel).toEqual({
      toolIds: ['app:*'],
      deferredToolIds: ['app:*'],
      disabledToolIds: [],
    })
    expect(toolState(sel, 'app:list_tags')).toBe('available')
    expect(toolState(sel, 'mcp:acme:post')).toBe('off')
  })
})
