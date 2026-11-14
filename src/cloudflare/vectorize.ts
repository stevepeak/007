import { tool } from 'ai'
import { z } from 'zod'

import type { ToolRegistryEntry } from '../engine/tool-registry'

// Cloudflare-native document search built-ins: `index_document` (a Tool node —
// chunk text, embed it with Workers AI, upsert it into Vectorize) and
// `search_documents` (an agent tool — embed the query, return the closest
// chunks). Each chunk's text rides in its vector's metadata, so a search needs
// no second store.
//
// The host wires the two bindings and, optionally, how a run is scoped
// (`getNamespace` — one Vectorize namespace per tenant, say). Index and search
// MUST share the embedding model and the index's dimensions must match it:
// BGE-M3 (the default) is 1024-dim, so
//   wrangler vectorize create <name> --dimensions=1024 --metric=cosine
//
// The usual graph: trigger → extract_text → index_document (text ← extract.text).

/** Workers AI embedding model used by both tools unless overridden. */
export const DEFAULT_EMBEDDING_MODEL = '@cf/baai/bge-m3'
/** Target characters per chunk — well under BGE-M3's 8k-token window. */
const DEFAULT_CHUNK_CHARS = 1500
/** Characters repeated across a hard split so no sentence is lost at a seam. */
const DEFAULT_CHUNK_OVERLAP = 200
/** Texts per Workers AI embedding call. */
const EMBED_BATCH = 50
/** Vectors per Vectorize upsert — the binding accepts up to 1000. */
const UPSERT_BATCH = 500
/** Vectorize caps topK at 50 when it returns metadata; keep answers small. */
const MAX_TOP_K = 20
const DEFAULT_TOP_K = 5

export const indexDocumentInputSchema = z.object({
  documentId: z
    .string()
    .min(1)
    .describe(
      'Stable id of the document (e.g. its R2 key). Re-indexing the same id overwrites its chunks.',
    ),
  title: z.string().nullish().describe('Human-readable document title.'),
  text: z.string().min(1).describe('The full document text to index.'),
})
export type IndexDocumentArgs = z.infer<typeof indexDocumentInputSchema>

export const indexDocumentOutputSchema = z.object({
  documentId: z.string(),
  chunks: z.number().describe('How many chunks were embedded and stored.'),
})
export type IndexDocumentResult = z.infer<typeof indexDocumentOutputSchema>

export const searchDocumentsInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('What to look for, phrased as a question or keywords.'),
  topK: z
    .number()
    .int()
    .min(1)
    .max(MAX_TOP_K)
    .nullish()
    .describe(`How many passages to return (default ${DEFAULT_TOP_K}).`),
})
export type SearchDocumentsArgs = z.infer<typeof searchDocumentsInputSchema>

const searchMatchSchema = z.object({
  documentId: z.string(),
  title: z.string().nullable(),
  chunk: z.number().describe('Position of the passage within its document.'),
  text: z.string(),
  score: z.number().describe('Similarity to the query; higher is closer.'),
})
export type SearchDocumentsMatch = z.infer<typeof searchMatchSchema>

export const searchDocumentsOutputSchema = z.object({
  matches: z.array(searchMatchSchema),
})
export type SearchDocumentsResult = z.infer<typeof searchDocumentsOutputSchema>

// What the tools write into each vector's metadata, read back on search. A
// vector written by anything else fails this and is skipped.
const chunkMetadataSchema = z.object({
  documentId: z.string(),
  title: z.string().optional(),
  chunk: z.number(),
  text: z.string(),
})

const embeddingOutputSchema = z.object({ data: z.array(z.array(z.number())) })

// `Ai.run` is typed per model id; the model is a host option, so call it
// through this narrow shape and validate what comes back.
type EmbeddingAI = {
  run(model: string, inputs: { text: string[] }): Promise<unknown>
}

export type VectorizeToolOptions<TDeps> = {
  /** The Vectorize index the chunks live in. */
  getIndex: (deps: TDeps) => Vectorize
  /** Workers AI binding — embeds chunks and queries. */
  getAI: (deps: TDeps) => Ai
  /**
   * Vectorize namespace for this run — how a host keeps one tenant's documents
   * out of another's search. `undefined` (the default) is the index's default
   * namespace. Index and search must resolve the same value for the same scope.
   */
  getNamespace?: (deps: TDeps) => string | undefined
  /**
   * Workers AI text-embedding model (default {@link DEFAULT_EMBEDDING_MODEL}).
   * Changing it means re-indexing: the index's dimensions are fixed.
   */
  embeddingModel?: string
}

export type CreateIndexDocumentToolOptions<TDeps> =
  VectorizeToolOptions<TDeps> & {
    /** Target characters per chunk (default 1500). */
    chunkChars?: number
    /** Overlap when a paragraph is hard-split (default 200). */
    chunkOverlap?: number
    /** Replace the paragraph chunker entirely. */
    chunk?: (args: { text: string }) => string[]
    /** Override the registry id (default `index_document`). */
    id?: string
  }

export type CreateSearchDocumentsToolOptions<TDeps> =
  VectorizeToolOptions<TDeps> & {
    /** Override the registry id (default `search_documents`). */
    id?: string
    /** Override what the model is told about when to search. */
    description?: string
  }

/**
 * Split on blank lines and pack paragraphs into chunks of about `chunkChars`;
 * a paragraph longer than that is hard-split with `chunkOverlap`.
 */
export function chunkText(args: {
  text: string
  chunkChars?: number
  chunkOverlap?: number
}): string[] {
  const size = args.chunkChars ?? DEFAULT_CHUNK_CHARS
  const step =
    size - Math.min(args.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP, size - 1)
  const paragraphs = args.text
    .split(/\n\s*\n/)
    .map((p) => {
      return p.trim()
    })
    .filter(Boolean)
  const chunks: string[] = []
  let current = ''
  for (const paragraph of paragraphs) {
    if (paragraph.length > size) {
      if (current) chunks.push(current)
      current = ''
      for (let i = 0; ; i += step) {
        chunks.push(paragraph.slice(i, i + size))
        if (i + size >= paragraph.length) break
      }
    } else if (current && current.length + paragraph.length + 2 > size) {
      chunks.push(current)
      current = paragraph
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph
    }
  }
  if (current) chunks.push(current)
  return chunks
}

/**
 * Vector id for one chunk. Vectorize ids are capped at 64 bytes and a document
 * id (an R2 key) can be longer, so the id is a hash; the raw document id rides
 * in metadata.
 */
export async function chunkVectorId(args: {
  documentId: string
  chunk: number
}): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(args.documentId),
  )
  const hex = Array.from(new Uint8Array(digest).slice(0, 16), (b) => {
    return b.toString(16).padStart(2, '0')
  }).join('')
  return `${hex}#${args.chunk}`
}

async function embed(args: {
  ai: Ai
  model: string
  texts: string[]
}): Promise<number[][]> {
  const ai = args.ai as unknown as EmbeddingAI
  const vectors: number[][] = []
  for (let i = 0; i < args.texts.length; i += EMBED_BATCH) {
    const batch = args.texts.slice(i, i + EMBED_BATCH)
    const parsed = embeddingOutputSchema.safeParse(
      await ai.run(args.model, { text: batch }),
    )
    if (!parsed.success || parsed.data.data.length !== batch.length) {
      throw new Error(
        `${args.model} returned no embeddings for ${batch.length} text(s)`,
      )
    }
    vectors.push(...parsed.data.data)
  }
  return vectors
}

export function createIndexDocumentTool<TDeps>(
  opts: CreateIndexDocumentToolOptions<TDeps>,
): ToolRegistryEntry<TDeps> {
  const model = opts.embeddingModel ?? DEFAULT_EMBEDDING_MODEL
  return {
    id: opts.id ?? 'index_document',
    // Shipped by the SDK — see `ToolMeta.origin`.
    origin: 'sdk',
    name: 'Index Document',
    description:
      'Chunk a document, embed each chunk with Workers AI and store it in Vectorize for search.',
    iconName: 'DatabaseZap',
    color: 'emerald',
    // Writes the index. Idempotent: chunk ids derive from the document id, so a
    // retry or resume overwrites the same vectors.
    sideEffect: 'write',
    kind: 'function',
    inputSchema: indexDocumentInputSchema,
    outputSchema: indexDocumentOutputSchema,
    build: (deps) => {
      return async (rawArgs): Promise<IndexDocumentResult> => {
        const args = indexDocumentInputSchema.parse(rawArgs)
        const chunks = opts.chunk
          ? opts.chunk({ text: args.text })
          : chunkText({
              text: args.text,
              chunkChars: opts.chunkChars,
              chunkOverlap: opts.chunkOverlap,
            })
        const values = await embed({
          ai: opts.getAI(deps),
          model,
          texts: chunks,
        })
        const namespace = opts.getNamespace?.(deps)
        const vectors: VectorizeVector[] = await Promise.all(
          chunks.map(async (text, chunk) => {
            return {
              id: await chunkVectorId({ documentId: args.documentId, chunk }),
              values: values[chunk],
              namespace,
              metadata: {
                documentId: args.documentId,
                chunk,
                text,
                ...(args.title ? { title: args.title } : {}),
              },
            }
          }),
        )
        // TODO: a re-index that produces fewer chunks leaves the old tail in
        // place. Vectorize can't list by metadata, so fixing it needs the
        // previous chunk count from somewhere durable.
        const index = opts.getIndex(deps)
        for (let i = 0; i < vectors.length; i += UPSERT_BATCH) {
          await index.upsert(vectors.slice(i, i + UPSERT_BATCH))
        }
        return { documentId: args.documentId, chunks: chunks.length }
      }
    },
  }
}

export function createSearchDocumentsTool<TDeps>(
  opts: CreateSearchDocumentsToolOptions<TDeps>,
): ToolRegistryEntry<TDeps> {
  const model = opts.embeddingModel ?? DEFAULT_EMBEDDING_MODEL
  return {
    id: opts.id ?? 'search_documents',
    // Shipped by the SDK — see `ToolMeta.origin`.
    origin: 'sdk',
    name: 'Search Documents',
    description:
      'Semantic search over indexed documents; returns the closest passages.',
    iconName: 'FileSearch',
    color: 'sky',
    sideEffect: 'read',
    statusLabel: 'Searching documents for ${query}',
    kind: 'ai-tool',
    inputSchema: searchDocumentsInputSchema,
    outputSchema: searchDocumentsOutputSchema,
    build: (deps) => {
      return tool({
        description:
          opts.description ??
          'Search the indexed documents for passages relevant to a query. Use it before answering questions about document contents, and name the document a passage came from.',
        inputSchema: searchDocumentsInputSchema,
        execute: async (
          args: SearchDocumentsArgs,
        ): Promise<SearchDocumentsResult> => {
          const [vector] = await embed({
            ai: opts.getAI(deps),
            model,
            texts: [args.query],
          })
          const result = await opts.getIndex(deps).query(vector, {
            topK: args.topK ?? DEFAULT_TOP_K,
            namespace: opts.getNamespace?.(deps),
            returnMetadata: 'all',
          })
          const matches: SearchDocumentsMatch[] = []
          for (const match of result.matches) {
            const metadata = chunkMetadataSchema.safeParse(match.metadata)
            if (!metadata.success) continue
            matches.push({
              documentId: metadata.data.documentId,
              title: metadata.data.title ?? null,
              chunk: metadata.data.chunk,
              text: metadata.data.text,
              score: match.score,
            })
          }
          return { matches }
        },
      })
    },
  }
}
