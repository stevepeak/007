import { describe, expect, test } from 'bun:test'

import {
  chunkText,
  chunkVectorId,
  createIndexDocumentTool,
  createSearchDocumentsTool,
  DEFAULT_EMBEDDING_MODEL,
  type IndexDocumentResult,
  type SearchDocumentsResult,
} from './vectorize'

type Deps = { namespace?: string }

/** Letter-frequency "embedding": texts sharing words land close together. */
function embedText(text: string): number[] {
  const v = Array.from({ length: 26 }, () => {
    return 0
  })
  for (const c of text.toLowerCase()) {
    const i = c.charCodeAt(0) - 97
    if (i >= 0 && i < 26) v[i] += 1
  }
  const norm = Math.hypot(...v) || 1
  return v.map((x) => {
    return x / norm
  })
}

/** In-memory Workers AI + Vectorize, recording what the tools sent. */
function harness() {
  const models: string[] = []
  const stored = new Map<string, VectorizeVector>()
  const ai = {
    run: (model: string, inputs: { text: string[] }) => {
      models.push(model)
      return Promise.resolve({ data: inputs.text.map(embedText) })
    },
  } as unknown as Ai
  const index = {
    upsert: (vectors: VectorizeVector[]) => {
      for (const v of vectors) stored.set(`${v.namespace ?? ''}/${v.id}`, v)
      return Promise.resolve({ mutationId: 'm1' })
    },
    query: (vector: number[], options: VectorizeQueryOptions) => {
      const matches = [...stored.values()]
        .filter((v) => {
          return (v.namespace ?? undefined) === options.namespace
        })
        .map((v) => {
          const values = v.values as number[]
          const score = values.reduce((sum, x, i) => {
            return sum + x * vector[i]
          }, 0)
          return { id: v.id, score, metadata: v.metadata }
        })
        .sort((a, b) => {
          return b.score - a.score
        })
        .slice(0, options.topK)
      return Promise.resolve({ matches, count: matches.length })
    },
  } as unknown as Vectorize
  const opts = {
    getIndex: () => {
      return index
    },
    getAI: () => {
      return ai
    },
    getNamespace: (deps: Deps) => {
      return deps.namespace
    },
  }
  const indexEntry = createIndexDocumentTool<Deps>(opts)
  const searchEntry = createSearchDocumentsTool<Deps>(opts)
  const indexDoc = (deps: Deps, args: unknown) => {
    if (indexEntry.kind !== 'function') throw new Error('expected a function')
    return indexEntry.build(deps)(args) as Promise<IndexDocumentResult>
  }
  const search = (deps: Deps, args: unknown) => {
    if (searchEntry.kind !== 'ai-tool') throw new Error('expected an ai-tool')
    // The AI SDK types `execute` loosely; the tool re-parses its own input.
    const built = searchEntry.build(deps)
    return (
      built.execute as (
        a: unknown,
        o: unknown,
      ) => Promise<SearchDocumentsResult>
    )(args, {})
  }
  return { indexEntry, searchEntry, indexDoc, search, stored, models }
}

describe('chunkText', () => {
  test('packs short paragraphs into one chunk', () => {
    expect(chunkText({ text: 'One.\n\nTwo.\n\n\nThree.' })).toEqual([
      'One.\n\nTwo.\n\nThree.',
    ])
  })

  test('starts a new chunk when the next paragraph would overflow', () => {
    const a = 'a'.repeat(1000)
    const b = 'b'.repeat(1000)
    expect(chunkText({ text: `${a}\n\n${b}` })).toEqual([a, b])
  })

  test('hard-splits a long paragraph with overlap', () => {
    const chunks = chunkText({ text: 'x'.repeat(3000) })
    expect(
      chunks.map((c) => {
        return c.length
      }),
    ).toEqual([1500, 1500, 400])
  })

  test('honours chunkChars / chunkOverlap', () => {
    expect(
      chunkText({ text: 'abcdefghij', chunkChars: 4, chunkOverlap: 1 }),
    ).toEqual(['abcd', 'defg', 'ghij'])
  })

  test('returns nothing for blank text', () => {
    expect(chunkText({ text: '  \n\n ' })).toEqual([])
  })
})

describe('chunkVectorId', () => {
  test('fits Vectorize’s 64-byte id cap for any document id', async () => {
    const id = await chunkVectorId({
      documentId: `uploads/${'deep/'.repeat(40)}file.pdf`,
      chunk: 123,
    })
    expect(new TextEncoder().encode(id).length).toBeLessThanOrEqual(64)
  })

  test('is stable per document and distinct per chunk', async () => {
    const a = await chunkVectorId({ documentId: 'doc', chunk: 0 })
    expect(await chunkVectorId({ documentId: 'doc', chunk: 0 })).toBe(a)
    expect(await chunkVectorId({ documentId: 'doc', chunk: 1 })).not.toBe(a)
  })
})

describe('index_document + search_documents', () => {
  test('ship as SDK built-ins with the expected kinds', () => {
    const { indexEntry, searchEntry } = harness()
    expect(indexEntry).toMatchObject({
      id: 'index_document',
      origin: 'sdk',
      kind: 'function',
      sideEffect: 'write',
    })
    expect(searchEntry).toMatchObject({
      id: 'search_documents',
      origin: 'sdk',
      kind: 'ai-tool',
      sideEffect: 'read',
    })
  })

  test('indexes chunks with metadata and finds the closest one', async () => {
    const h = harness()
    const out = await h.indexDoc(
      {},
      {
        documentId: 'handbook.md',
        title: 'Handbook',
        text:
          'The wifi password rotates every Monday.\n\n' +
          'Lunch is served at noon in the kitchen. '.repeat(40),
      },
    )
    expect(out).toEqual({ documentId: 'handbook.md', chunks: 3 })
    expect(h.stored.size).toBe(3)
    expect(new Set(h.models)).toEqual(new Set([DEFAULT_EMBEDDING_MODEL]))

    const { matches } = await h.search({}, { query: 'wifi password', topK: 1 })
    expect(matches).toEqual([
      {
        documentId: 'handbook.md',
        title: 'Handbook',
        chunk: 0,
        text: 'The wifi password rotates every Monday.',
        score: expect.any(Number) as number,
      },
    ])
  })

  test('re-indexing the same document overwrites its chunks', async () => {
    const h = harness()
    await h.indexDoc({}, { documentId: 'a', text: 'first version' })
    await h.indexDoc({}, { documentId: 'a', text: 'second version' })
    expect(h.stored.size).toBe(1)
    const { matches } = await h.search({}, { query: 'version' })
    expect(matches.map((m) => m.text)).toEqual(['second version'])
  })

  test('the namespace keeps one scope’s documents out of another’s search', async () => {
    const h = harness()
    await h.indexDoc({ namespace: 'org-a' }, { documentId: 'a', text: 'alpha' })
    await h.indexDoc({ namespace: 'org-b' }, { documentId: 'b', text: 'alpha' })
    const { matches } = await h.search(
      { namespace: 'org-a' },
      { query: 'alpha' },
    )
    expect(matches.map((m) => m.documentId)).toEqual(['a'])
  })

  test('skips vectors whose metadata it did not write', async () => {
    const h = harness()
    h.stored.set('/foreign', {
      id: 'foreign',
      values: embedText('alpha'),
      metadata: { other: 1 },
    })
    const { matches } = await h.search({}, { query: 'alpha' })
    expect(matches).toEqual([])
  })
})
