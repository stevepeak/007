import { describe, expect, test } from 'bun:test'
import { isValidElement, type ReactNode } from 'react'

import { highlightCode } from './highlight'

// Flatten the rendered spans back to the text they carry.
function textOf(nodes: ReactNode): string {
  if (nodes == null || typeof nodes === 'boolean') return ''
  if (typeof nodes === 'string') return nodes
  if (typeof nodes === 'number') return String(nodes)
  if (Array.isArray(nodes)) return nodes.map(textOf).join('')
  if (isValidElement<{ children?: ReactNode }>(nodes)) {
    return textOf(nodes.props.children)
  }
  return ''
}

// The property the whole overlay rests on: highlighting a document must not add,
// drop, or reorder a single character, or the coloured layer stops sitting
// underneath the textarea's characters and the editor looks broken.
describe('highlightCode round-trips the source', () => {
  const cases: [string, Parameters<typeof highlightCode>[1]][] = [
    ['{"a": 1, "b": [true, null, "x"], "c": {"d": -2.5e3}}', 'json'],
    ['z.object({ name: z.string().optional() }) // a comment', 'javascript'],
    ['claude mcp add --transport http wf https://example.com/api/mcp', 'bash'],
    ['{\n  "nested": {\n    "deep": ["a",\n      "b"]\n  }\n}', 'json'],
    ['  {"leading": "whitespace"}  \n\n', 'json'],
  ]
  for (const [code, language] of cases) {
    test(`${language}: ${code.slice(0, 32)}…`, () => {
      expect(textOf(highlightCode(code, language))).toBe(code)
    })
  }

  // A field is unparseable for as long as it takes to type it. The tokenizer has
  // to hand back every prefix intact, not just finished documents.
  test('every prefix of a document survives', () => {
    const doc = '{"memories": [{"id": "m1", "score": 0.4}]}'
    for (let i = 1; i <= doc.length; i++) {
      const prefix = doc.slice(0, i)
      expect(textOf(highlightCode(prefix, 'json'))).toBe(prefix)
    }
  })

  test('empty input renders nothing', () => {
    expect(highlightCode('', 'json')).toEqual([])
  })
})

describe('highlightCode colours', () => {
  test('tints a key differently from its string value', () => {
    const html = JSON.stringify(highlightCode('{"k": "v"}', 'json'))
    expect(html).toContain('text-sky-700')
    expect(html).toContain('text-green-700')
  })
})
