import { describe, expect, test } from 'bun:test'

import { nodeProgressMessage } from './node-progress'

// The user-facing progress line is opt-in: a step is silent unless the author
// wrote a `progressNote`. An agent that exposes its thinking streams its own
// reasoning/tool notes, which supersedes the static note.

describe('nodeProgressMessage', () => {
  test('a note-less node is silent (no derived title)', () => {
    expect(
      nodeProgressMessage({ id: 'n', kind: 'tool' }, undefined),
    ).toBe('')
  })

  test('interpolates the author note from run variables', () => {
    expect(
      nodeProgressMessage(
        { id: 'n', kind: 'tool', progressNote: 'Looking up record ${n}' },
        { n: '42' },
      ),
    ).toBe('Looking up record 42')
  })

  test('an agent that exposes thinking suppresses its static note', () => {
    expect(
      nodeProgressMessage(
        {
          id: 'a',
          kind: 'agent',
          progressNote: 'Researching…',
          config: { exposeThinking: true },
        },
        undefined,
      ),
    ).toBe('')
  })

  test('an agent NOT exposing thinking still shows its note', () => {
    expect(
      nodeProgressMessage(
        {
          id: 'a',
          kind: 'agent',
          progressNote: 'Researching…',
          config: { exposeThinking: false },
        },
        undefined,
      ),
    ).toBe('Researching…')
  })
})
