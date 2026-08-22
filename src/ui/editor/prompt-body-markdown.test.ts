import { MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, test } from 'bun:test'

import {
  inferPromptVariables,
  unescapePromptVariables,
} from '../../engine/prompt-variables'

// `PromptBodyEditor` stores Markdown, and `@tiptap/markdown`'s serializer
// backslash-escapes every markdown-significant character — `_` included, with no
// regard for whether it could actually open emphasis. That turned `${my_var}`
// into `${my\_var}` on disk: chipped and correct-looking in the editor (which
// re-parses the escape away), invisible to variable inference, and delivered to
// the model as literal text (ART-49).
//
// These pin the two halves of the fix against a Tiptap upgrade: the escaping
// behaviour we're compensating for, and the round trip staying intact once we
// compensate. They drive the serializer directly — a real `Editor` needs a DOM.
const md = new MarkdownManager({ extensions: [StarterKit] })
function roundTrip (body: string) {
  return unescapePromptVariables(md.serialize(md.parse(body)))
}

describe('prompt body Markdown round trip', () => {
  test('the serializer still escapes `_`, which is why we unescape', () => {
    expect(md.serialize(md.parse('Summarize ${my_var}'))).toContain('${my\\_var}')
  })

  test('an underscore variable survives a round trip and stays inferable', () => {
    const body = 'Summarize ${doc_text} for ${client_name}.'
    expect(roundTrip(body)).toBe(body)
    expect(inferPromptVariables(roundTrip(body))).toEqual([
      'doc_text',
      'client_name',
    ])
  })

  test('a hyphen variable needs no escaping at all', () => {
    const body = 'Review ${case-id}.'
    expect(roundTrip(body)).toBe(body)
    expect(inferPromptVariables(roundTrip(body))).toEqual(['case-id'])
  })

  test('a stored edge-underscore name keeps its escape, and stays inferable', () => {
    // Left escaped on purpose. Bare, the two underscores pair up into emphasis
    // on the next parse, so the escape is the only form that survives — which
    // is why `unescapePromptVariables` exempts them and the engine reads both.
    const body = 'A ${\\_lead} and ${trail\\_}.'
    expect(roundTrip(body)).toBe(body)
    expect(inferPromptVariables(roundTrip(body))).toEqual(['_lead', 'trail_'])
  })

  test('KNOWN LIMIT: two bare edge-underscore names typed together collapse', () => {
    // Nothing downstream can fix this — Markdown *parsing*, inside the editor,
    // turns `_lead} and ${trail_` into emphasis before any of our code sees the
    // text. Only two such names in ONE paragraph do it; one on its own is fine.
    expect(roundTrip('A ${_lead} and ${trail_}.')).toBe('A ${*lead} and ${trail*}.')
    expect(roundTrip('A ${_lead} alone.')).toBe('A ${\\_lead} alone.')
  })

  test('repeated round trips are stable', () => {
    const body = 'Summarize ${doc_text} and ${_lead}.'
    expect(roundTrip(roundTrip(roundTrip(body)))).toBe(roundTrip(body))
  })
})
