// `create_document` — the agent-callable tool that turns an authored model into
// a stored `.docx`, with the fact guardrail in front of it.
//
// WHY `store` IS A CALLBACK, and not a `getBucket` accessor like
// `createExtractTextTool` takes. Two reasons, and they are the design decision
// in this file:
//
//   1. This module imports ZERO Cloudflare types, so `@stevepeak/007/documents`
//      stays portable to a client that is not a Worker.
//   2. Writing the bytes and recording the row stay ONE host-side operation.
//      Split across the package boundary, the failure modes are an orphaned
//      object with no row, or a row pointing at bytes that were never written —
//      and only the host can clean up after itself.
//
// `getBucket` was right for `extract_text` because reading and writing blobs IS
// that tool's job. Generating a document is not a storage operation; storage is
// the host's consequence of one.

import { tool } from 'ai'
import { z } from 'zod'

import type { ToolRegistryEntry } from '../engine/tool-registry'

import {
  checkFacts,
  factCheckErrorMessage,
  type FactCheckResult,
} from './check-facts'
import { documentModelSchema, type DocumentModel } from './model'
import { renderDocx, type RenderDocxOptions } from './render-docx'

/** What a `.docx` is, to Word and to an HTTP `Content-Type`. */
export const DOCX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/** The rendered document handed to the host's `store`. Bytes, once, in memory. */
export type GeneratedDocument = {
  /** The rendered `.docx`. */
  bytes: Uint8Array
  /** The model that produced them — persist it, see below. */
  model: DocumentModel
  /** A safe file name derived from the title. */
  filename: string
  /** Always {@link DOCX_MIME_TYPE}; passed so the host never hardcodes it. */
  mimeType: string
}

/** What the host reports back after storing — and all the agent ever sees. */
export type StoredDocument = {
  documentId: string
  filename: string
}

/** Thrown when the document states a figure the facts do not support. */
export class FactCheckFailedError extends Error {
  constructor(readonly result: FactCheckResult) {
    super(factCheckErrorMessage(result))
    this.name = 'FactCheckFailedError'
  }
}

export type CreateDocumentToolOptions<TDeps> = {
  /**
   * Persist the rendered document and return its identity.
   *
   * Do the blob write and the row insert together, and undo the blob if the row
   * fails: this callback is the only place that can, and a `.docx` in storage
   * that nothing references is a document nobody can find and nobody can delete.
   *
   * PERSIST `model` ALONGSIDE THE BYTES. It costs nothing now and it is the
   * difference between "change paragraph 3" being an edit and being a rewrite —
   * the bytes are an output, the model is the document.
   */
  store: (deps: TDeps, document: GeneratedDocument) => Promise<StoredDocument>
  /**
   * The authoritative facts for this run, read from the host's own context.
   *
   * SET THIS WHERE YOU CAN. Without it the tool falls back to the `facts` the
   * MODEL restated in its own call, which still catches the observed failure —
   * a model filling a table with figures it invented on the spot, having never
   * listed them as facts — but cannot catch a model that fabricates a figure
   * and dutifully lists it as a fact. Only host-supplied facts make the check
   * adversarially sound, because only they come from outside the model.
   */
  getFacts?: (deps: TDeps) => unknown
  /** Override the registry id (default `create_document`). */
  id?: string
  /** Registry display metadata — see `ToolMeta`. */
  name?: string
  description?: string
  icon?: string
  iconName?: string
  color?: string
  statusLabel?: string
  requiresContext?: readonly string[]
  /** Renderers for host-defined block types. See `renderDocx`. */
  extraRenderers?: RenderDocxOptions['extraRenderers']
}

const CREATE_DOCUMENT_INPUT_SCHEMA = z.object({
  facts: z
    .array(z.string())
    .describe(
      'Every fact this document relies on, copied VERBATIM from what you were given — each amount, invoice number, and date exactly as supplied. The document is rejected if it states a figure that does not appear here or is not a sum of figures here. Never add a figure to this list that you were not given.',
    ),
  document: documentModelSchema.describe('The document to generate.'),
})

const CREATE_DOCUMENT_OUTPUT_SCHEMA = z.object({
  documentId: z
    .string()
    .describe('The stored document id — cite this when telling the user.'),
  filename: z.string().describe('The file name the user will download.'),
})

/**
 * A safe, human-readable file name for a document title.
 *
 * Kept readable rather than hashed because it is the name that lands in the
 * user's Downloads folder and in an R2 listing; kept ASCII-ish and separator-
 * free because it becomes the last segment of an object key.
 */
export function documentFilename(title: string): string {
  const base = title
    .normalize('NFKD')
    .replaceAll(/[^\w\s.-]/g, '')
    .trim()
    .replaceAll(/\s+/g, '-')
    .replaceAll(/-{2,}/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 80)
    .replace(/[.-]+$/, '')
  return `${base || 'document'}.docx`
}

/**
 * Build the `create_document` registry entry.
 *
 * The order of operations is deliberate: validate, then CHECK THE FACTS, then
 * render, then store. Checking first means a fabricating document costs no
 * rendering and — more importantly — never reaches storage, so there is no
 * window in which a document that should not exist has an id someone could
 * link to.
 */
export function createDocumentTool<TDeps>(
  opts: CreateDocumentToolOptions<TDeps>,
): ToolRegistryEntry<TDeps> {
  return {
    id: opts.id ?? 'create_document',
    // Shipped by the SDK — see `ToolMeta.origin`. True even when the host
    // renames it: `opts.name` re-labels the tool, it does not re-author it.
    origin: 'sdk',
    name: opts.name ?? 'Create Document',
    description:
      opts.description ??
      'Author a Word document (.docx) the user can download and edit.',
    icon: opts.icon,
    iconName: opts.iconName,
    color: opts.color,
    // Static, and it has to be: a `statusLabel` is interpolated from the tool
    // call's TOP-LEVEL args only (`PROMPT_VARIABLE_RE` is `[\w-]+`, no dots), so
    // `${document.title}` is not a token at all — it would reach the end user as
    // that literal string. `${document}` would resolve, and JSON-stringify the
    // whole document into the progress feed.
    statusLabel: opts.statusLabel ?? 'Writing the document',
    requiresContext: opts.requiresContext,
    // A document that reaches storage is a side effect, so an eval that runs
    // under `simulate` must not write one.
    sideEffect: 'write',
    kind: 'ai-tool',
    inputSchema: CREATE_DOCUMENT_INPUT_SCHEMA,
    outputSchema: CREATE_DOCUMENT_OUTPUT_SCHEMA,
    build: (deps) =>
      tool({
        description:
          opts.description ??
          'Author a Word document (.docx) the user can download and edit. Supply the document as structured blocks — never as raw text or XML — and list every fact it relies on. Returns the stored document id; the bytes are never returned.',
        inputSchema: CREATE_DOCUMENT_INPUT_SCHEMA,
        execute: async (rawArgs): Promise<StoredDocument> => {
          const args = CREATE_DOCUMENT_INPUT_SCHEMA.parse(rawArgs)
          const facts = opts.getFacts ? opts.getFacts(deps) : args.facts
          const result = checkFacts(facts, args.document)
          if (!result.ok) {
            // Thrown, not returned: the AI SDK surfaces it to the model as a
            // tool error, which is exactly the retry loop we want — the agent
            // sees which figures were rejected and rewrites the document.
            // Returning it as a normal result would let a model that ignores
            // the field carry on as though the document had been created.
            throw new FactCheckFailedError(result)
          }
          const bytes = await renderDocx(args.document, {
            extraRenderers: opts.extraRenderers,
          })
          return await opts.store(deps, {
            bytes,
            model: args.document,
            filename: documentFilename(args.document.title),
            mimeType: DOCX_MIME_TYPE,
          })
        },
      }),
  }
}
