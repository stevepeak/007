import { describe, expect, test } from 'bun:test'

import { nodeProgressMessage } from './node-progress'

// The user-facing progress line is opt-in: a step is silent unless its
// `informUser` mode is `static`. `dynamic` streams the agent's own reasoning/
// tool notes instead (and, being a separate mode, carries no static note); `off`
// says nothing.

describe('nodeProgressMessage', () => {
  test('an off node is silent (no derived title)', () => {
    expect(
      nodeProgressMessage(
        { id: 'n', kind: 'tool', informUser: { mode: 'off' } },
        undefined,
      ),
    ).toBe('')
  })

  test('interpolates the static note from run variables', () => {
    expect(
      nodeProgressMessage(
        {
          id: 'n',
          kind: 'tool',
          informUser: { mode: 'static', note: 'Looking up record ${n}' },
        },
        { n: '42' },
      ),
    ).toBe('Looking up record 42')
  })

  test('a dynamic (streaming) agent emits no static line', () => {
    expect(
      nodeProgressMessage(
        {
          id: 'a',
          kind: 'agent',
          informUser: { mode: 'dynamic', reasoning: true, tools: true },
        },
        undefined,
      ),
    ).toBe('')
  })

  test('a static agent shows its note', () => {
    expect(
      nodeProgressMessage(
        {
          id: 'a',
          kind: 'agent',
          informUser: { mode: 'static', note: 'Researching…' },
        },
        undefined,
      ),
    ).toBe('Researching…')
  })
})
