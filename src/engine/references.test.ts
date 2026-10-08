import { describe, expect, test } from 'bun:test'

import {
  checkReferences,
  parseReferenceHref,
  parseReferences,
  referenceKindProblems,
  referencePromptBlock,
  stringifyReference,
  stripReferences,
  type ReferenceKind,
} from './references'

const RECORD: ReferenceKind = {
  id: 'record',
  label: 'Record',
  description: 'A stored record.',
  guidance: 'Reference each record you used; copy its `recordId`.',
  anchor: 'The `partId` of the passage, when you have one.',
  quote: true,
  example: {
    id: 'rec-example',
    anchor: 'p2',
    quote: 'the sky is blue',
    label: 'Weather notes',
  },
}

const PAGE: ReferenceKind = {
  id: 'page',
  label: 'Page',
  description: 'A web page.',
  guidance: 'Reference each page by its `pageId`.',
  example: { id: 'pg-example', label: 'Home' },
}

describe('grammar', () => {
  test('round-trips through stringify → parse', () => {
    const text = `See ${stringifyReference({
      kind: 'record',
      id: 'rec 1(a)',
      anchor: 'p/2',
      quote: 'a "quoted" line',
      label: 'Notes [draft]',
    })}.`
    const [ref] = parseReferences(text)
    expect(ref).toMatchObject({
      kind: 'record',
      id: 'rec 1(a)',
      anchor: 'p/2',
      quote: 'a  quoted  line',
      label: 'Notes  draft',
    })
    expect(text.slice(ref.start, ref.end)).toBe(ref.raw)
  })

  test('parses what a model writes by hand', () => {
    const refs = parseReferences(
      'Blue [Weather notes](#ref:record/rec-7/p2 "the sky is blue") and [Home](#ref:page/pg-1).',
    )
    expect(refs.map(({ kind, id, anchor, quote, label }) => ({ kind, id, anchor, quote, label }))).toEqual([
      { kind: 'record', id: 'rec-7', anchor: 'p2', quote: 'the sky is blue', label: 'Weather notes' },
      { kind: 'page', id: 'pg-1', anchor: undefined, quote: undefined, label: 'Home' },
    ])
  })

  test('ignores ordinary links, code, and a link still streaming in', () => {
    expect(
      parseReferences(
        '[a](https://x.test) `[b](#ref:page/pg-1)` ```\n[c](#ref:page/pg-2)\n``` [d](#ref:page/pg-3',
      ),
    ).toEqual([])
  })

  test('parseReferenceHref rejects malformed hrefs', () => {
    expect(parseReferenceHref('#doc-1')).toBeNull()
    expect(parseReferenceHref('#ref:Bad/1')).toBeNull()
    expect(parseReferenceHref('#ref:page/')).toBeNull()
    expect(parseReferenceHref('#ref:page/pg%201')).toEqual({ kind: 'page', id: 'pg 1' })
  })

  test('stripReferences leaves only labels', () => {
    expect(
      stripReferences('Blue [Weather notes](#ref:record/rec-7 "x"), [x](https://y.test).'),
    ).toBe('Blue Weather notes, [x](https://y.test).')
  })
})

describe('referencePromptBlock', () => {
  test('is empty with no kinds', () => {
    expect(referencePromptBlock([])).toBe('')
  })

  test('describes each kind with a parseable example', () => {
    const block = referencePromptBlock([RECORD, PAGE])
    expect(block).toContain('### Record (`record`)')
    expect(block).toContain('Anchor: The `partId`')
    const ids = parseReferences(block.replaceAll('    [label]', '')).map((r) => r.id)
    expect(ids).toEqual(['rec-example', 'pg-example'])
  })
})

describe('checkReferences', () => {
  const evidence = JSON.stringify([{ recordId: 'rec-7', partId: 'p2' }, { pageId: 'pg-1' }])

  test('keeps sourced references verbatim and returns them structured', () => {
    const text = 'Blue [Notes](#ref:record/rec-7/p2 "the sky") and [Home](#ref:page/pg-1).'
    const r = checkReferences({ text, kinds: [RECORD, PAGE], evidence })
    expect(r.text).toBe(text)
    expect(r.issues).toEqual([])
    expect(r.references).toEqual([
      { kind: 'record', id: 'rec-7', anchor: 'p2', quote: 'the sky', label: 'Notes' },
      { kind: 'page', id: 'pg-1', label: 'Home' },
    ])
  })

  test('unwraps unsourced ids and kinds not enabled to their labels', () => {
    const r = checkReferences({
      text: 'A [Made up](#ref:record/rec-404) B [Home](#ref:page/pg-1)',
      kinds: [RECORD],
      evidence,
    })
    expect(r.text).toBe('A Made up B Home')
    expect(r.references).toEqual([])
    expect(r.issues.map((i) => i.problem)).toEqual(['unsourced', 'unknown-kind'])
  })

  test('drops an anchor or quote the kind does not take, keeping the reference', () => {
    const r = checkReferences({
      text: '[Home](#ref:page/pg-1/top "hello")',
      kinds: [PAGE],
      evidence,
    })
    expect(r.text).toBe('[Home](#ref:page/pg-1)')
    expect(r.issues.map((i) => i.problem)).toEqual(['anchor-dropped', 'quote-dropped'])
  })

  test('does not count the prompt example as evidence', () => {
    const r = checkReferences({
      text: '[Weather notes](#ref:record/rec-example)',
      kinds: [RECORD],
      evidence,
    })
    expect(r.references).toEqual([])
  })

  test('dedupes repeated references', () => {
    const r = checkReferences({
      text: '[Home](#ref:page/pg-1) again [the home page](#ref:page/pg-1)',
      kinds: [PAGE],
      evidence,
    })
    expect(r.references).toEqual([{ kind: 'page', id: 'pg-1', label: 'Home' }])
  })
})

describe('referenceKindProblems', () => {
  test('flags malformed and duplicate ids', () => {
    expect(referenceKindProblems([RECORD, PAGE])).toEqual([])
    expect(referenceKindProblems([{ ...PAGE, id: 'Page' }, PAGE, PAGE])).toHaveLength(2)
  })
})
