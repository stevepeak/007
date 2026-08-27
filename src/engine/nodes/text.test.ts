import { describe, expect, test } from 'bun:test'

import type { TextNode } from '../graph'

import { executeTextNode } from './text'

// Build a minimal Text node with the given config.
function node(config: Partial<TextNode['config']>): TextNode {
  return {
    id: 'txt',
    kind: 'text',
    label: 'Draft the reply',
    position: { x: 0, y: 0 },
    informUser: { mode: 'off' },
    config: { body: '', inputs: {}, ...config },
  }
}

describe('executeTextNode', () => {
  test('fills each variable from its binding', async () => {
    const r = await executeTextNode({
      node: node({
        body: 'Dear ${name}, we found ${count} conflicts.',
        inputs: {
          name: { kind: 'ref', nodeId: 'lookup', path: 'client.name' },
          count: { kind: 'ref', nodeId: 'check', path: 'total' },
        },
      }),
      nodeOutputs: new Map<string, unknown>([
        ['lookup', { client: { name: 'Dana' } }],
        ['check', { total: 2 }],
      ]),
    })
    expect(r.output).toBe('Dear Dana, we found 2 conflicts.')
  })

  test('emits the body verbatim when it has no variables', async () => {
    const r = await executeTextNode({
      node: node({ body: '# Heading\n\nJust **prose**.' }),
      nodeOutputs: new Map(),
    })
    expect(r.output).toBe('# Heading\n\nJust **prose**.')
  })

  test('reads a variable escaped by the Markdown serializer', async () => {
    // `@tiptap/markdown` escapes `_`, so a stored body can carry `${my\_var}`.
    // The engine has to bind that to the same `my_var` the editor lists.
    const r = await executeTextNode({
      node: node({
        body: 'Matter: ${my\\_var}',
        inputs: { my_var: { kind: 'literal', value: 'Acme v. Ajax' } },
      }),
      nodeOutputs: new Map(),
    })
    expect(r.output).toBe('Matter: Acme v. Ajax')
  })

  test('stringifies a non-string value and blanks a null one', async () => {
    const r = await executeTextNode({
      node: node({
        body: '${obj} / ${missing} /',
        inputs: {
          obj: { kind: 'ref', nodeId: 'tool', path: '' },
          missing: { kind: 'ref', nodeId: 'tool', path: 'nope' },
        },
      }),
      nodeOutputs: new Map<string, unknown>([['tool', { a: 1 }]]),
    })
    expect(r.output).toBe('{"a":1} /  /')
  })

  test('rehydrates a value spilled to blob storage before interpolating', async () => {
    const r = await executeTextNode({
      node: node({
        body: 'Summary: ${memo}',
        inputs: { memo: { kind: 'ref', nodeId: 'agent', path: 'text' } },
      }),
      nodeOutputs: new Map<string, unknown>([['agent', { text: 'BLOB' }]]),
      rehydrate: async (v) => (v === 'BLOB' ? 'the real memo' : v),
    })
    expect(r.output).toBe('Summary: the real memo')
  })

  test('throws on an unbound variable rather than emitting the raw token', async () => {
    // The whole point of the node is text a person reads, so a half-filled
    // sentence is a worse outcome than a failed run.
    const run = executeTextNode({
      node: node({ body: 'Hello ${name}, re ${matter}.' }),
      nodeOutputs: new Map(),
    })
    expect(run).rejects.toThrow(
      /Draft the reply has unbound variables: \$\{name\}, \$\{matter\}/,
    )
  })

  test('throws when the body is empty', async () => {
    const run = executeTextNode({
      node: node({ body: '   ' }),
      nodeOutputs: new Map(),
    })
    expect(run).rejects.toThrow(/has no text/)
  })

  test('ignores a stale binding the body no longer mentions', async () => {
    // An author who deletes a `${token}` leaves its row behind. Resolving it
    // would throw on a ref into a node that has since been removed.
    const r = await executeTextNode({
      node: node({
        body: 'Just ${kept}.',
        inputs: {
          kept: { kind: 'literal', value: 'this' },
          gone: { kind: 'ref', nodeId: 'deleted-node', path: 'x' },
        },
      }),
      nodeOutputs: new Map(),
    })
    expect(r.output).toBe('Just this.')
  })
})
