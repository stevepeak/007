import { z } from 'zod'

import type { WfBlobRef } from '../engine/blob-ref'
import type { ToolRegistryEntry } from '../engine/tool-registry'

import { spillTextIfLarge } from './blob-spill'
import {
  cloudflareVisionRecognizer,
  DEFAULT_VISION_MODEL,
  ocrPdf,
  type OcrRecognize,
} from './extract-text-ocr'

// Re-exported so the public `./cloudflare/extract-text` entry (and `./cloudflare`
// barrel) keeps offering the OCR seam even though it now lives in its own module.
export {
  cloudflareVisionRecognizer,
  type OcrRecognize,
} from './extract-text-ocr'

// Cloudflare-native `extract_text` built-in: fetch an uploaded file from R2 and
// return its text. Plain text/markdown passes through; everything else goes
// through Workers AI `toMarkdown`; a scanned PDF (empty text layer) falls back
// to Browser-Rendering page rasterization + a vision OCR pass.
//
// This lives under `./cloudflare` (not the provider-agnostic `./tools`) because
// it touches Worker bindings (R2, Workers AI, Browser Rendering). The one piece
// that legitimately varies per project — the page-image → text vision call — is
// injectable via `getRecognize`; when omitted it defaults to Workers AI vision,
// so a fully-Cloudflare host needs zero extra wiring.
//
// Large-document memory: a big (esp. OCR'd) document can exceed Cloudflare
// Workflows' per-step output size and would bloat the run recorder if returned
// inline. So when the extracted text exceeds `spillThreshold`, the tool writes
// it back to R2 and returns the `text` field as a `WfBlobRef` pointer (with an
// inline preview). Downstream agent/tool nodes rehydrate it transparently via
// the host's `resolveBlobRef` (wire `createR2BlobResolver` in) — graph bindings
// like `ref(extract, 'text')` need no change, and the full text never crosses a
// step boundary. Below the threshold, `text` stays an inline string as before.

// Spill the extracted text to R2 (return a pointer) once it exceeds this many
// bytes. Chosen well under Cloudflare Workflows' per-step output limit so the
// pointer + preview comfortably fit; override via `spillThreshold`.
const DEFAULT_SPILL_THRESHOLD = 128 * 1024
// Characters of the extracted text kept inline on the pointer for traces/UI.
const DEFAULT_PREVIEW_CHARS = 2000
// R2 key prefix for spilled extractions; override via `spillKeyPrefix`.
const DEFAULT_SPILL_PREFIX = 'extracted/'

export const extractTextInputSchema = z.object({
  source: z
    .string()
    .min(1)
    .describe('R2 object key of the uploaded file to extract.'),
  mimeType: z.string().default('').describe('MIME type of the file.'),
  filename: z
    .string()
    .default('document')
    .describe('Original filename — drives passthrough + toMarkdown naming.'),
  forceOcr: z
    .boolean()
    .optional()
    .describe('OCR the PDF even when a text layer is present.'),
})
export type ExtractTextArgs = z.infer<typeof extractTextInputSchema>

export const extractTextOutputSchema = z.object({
  text: z
    .string()
    .describe(
      'The extracted document text. A large document is spilled to storage and this field carries a pointer instead; downstream nodes rehydrate it to the full text automatically.',
    ),
  mode: z
    .enum(['passthrough', 'markdown', 'ocr'])
    .describe('How the text was obtained.'),
  meta: z.object({
    pages: z.number().optional().describe('Page count when OCR ran.'),
    ocr: z.boolean().describe('Whether the OCR fallback was used.'),
    spilled: z
      .boolean()
      .optional()
      .describe(
        'Whether the text was spilled to storage and returned as a pointer.',
      ),
    notes: z.string().optional(),
  }),
})

export type ExtractTextMode = 'passthrough' | 'markdown' | 'ocr'

export type ExtractTextMeta = {
  pages?: number
  ocr: boolean
  spilled?: boolean
  notes?: string
}

// `text` is a plain string for small documents and a `WfBlobRef` pointer for
// large ones (see the spill note at the top). The declared `outputSchema` above
// keeps it typed as a string for the editor's data-mapping UI — downstream nodes
// bind `ref(extract, 'text')` the same way and the engine rehydrates the pointer
// transparently.
export type ExtractTextResult = {
  text: string | WfBlobRef
  mode: ExtractTextMode
  meta: ExtractTextMeta
}

// `toMarkdown` isn't in @cloudflare/workers-types yet — describe the slice we use.
type ToMarkdownAI = {
  toMarkdown(
    files: { name: string; blob: Blob }[],
  ): Promise<{ name: string; data: string }[]>
}

export type CreateExtractTextToolOptions<TDeps> = {
  /** R2 bucket the uploaded bytes live in. */
  getBucket: (deps: TDeps) => R2Bucket
  /** Workers AI binding — used for `toMarkdown` and the default OCR vision. */
  getAI: (deps: TDeps) => Ai
  /** Browser Rendering binding. Provide it to enable scanned-PDF OCR. */
  getBrowser?: (deps: TDeps) => Fetcher
  /** Custom page → text recognizer; defaults to Workers AI vision. */
  getRecognize?: (deps: TDeps) => OcrRecognize
  /** Workers AI vision model for the default recognizer. */
  visionModel?: string
  /** Override the registry id (default `extract_text`). */
  id?: string
  /** Inline SVG icon for the tool picker. */
  icon?: string
  /**
   * Spill the extracted text to R2 (return a `WfBlobRef` pointer) once it
   * exceeds this many bytes. Default {@link DEFAULT_SPILL_THRESHOLD}. Set to
   * `Infinity` to always return inline text (no spill), or `0` to always spill.
   */
  spillThreshold?: number
  /**
   * R2 bucket the spilled text is written to. Defaults to `getBucket` (the same
   * bucket the source lives in). Wire the matching `createR2BlobResolver` at the
   * same bucket so downstream rehydration reads it back.
   */
  getSpillBucket?: (deps: TDeps) => R2Bucket
  /** Key prefix for spilled objects (default `extracted/`). */
  spillKeyPrefix?: string
  /** Derive the full spill key from the args (overrides `spillKeyPrefix`). */
  spillKey?: (args: ExtractTextArgs, deps: TDeps) => string
  /** Characters of text kept inline on the pointer preview (default 2000). */
  previewChars?: number
}

function isPlainText(mimeType: string, filename: string): boolean {
  const name = filename.toLowerCase()
  return (
    mimeType === 'text/plain' ||
    mimeType === 'text/markdown' ||
    name.endsWith('.txt') ||
    name.endsWith('.md')
  )
}

// Heuristic: is this `toMarkdown` output suspiciously empty for its page count?
// toMarkdown emits a `### Page N` heading per PDF page; a scanned PDF has the
// headings but almost no body text under them.
export function looksLikeScannedPdf(
  markdown: string,
  opts: { minCharsPerPage?: number } = {},
): boolean {
  const minCharsPerPage = opts.minCharsPerPage ?? 40
  const pageHeaders = markdown.match(/^### Page \d+\s*$/gm) ?? []
  if (pageHeaders.length === 0) return false
  const body = markdown
    .replace(/^# .+\n/m, '')
    // Strip the `## Metadata` block up to the next `##`/`###` heading or EOF.
    .replace(/^## Metadata[\s\S]*?(?=^##|(?![\s\S]))/m, '')
    .replaceAll(/^### Page \d+\s*$/gm, '')
    .replaceAll(/\s+/g, ' ')
    .trim()
  return body.length < minCharsPerPage * pageHeaders.length
}

async function runToMarkdown(
  ai: Ai,
  name: string,
  blob: Blob,
): Promise<string> {
  const res = await (ai as unknown as ToMarkdownAI).toMarkdown([{ name, blob }])
  return res[0]?.data ?? ''
}

// When the freshly extracted text is larger than the spill threshold, write it
// to R2 and swap the inline string for a `WfBlobRef` pointer; otherwise return
// it unchanged. The byte-threshold write lives in the generic `spillTextIfLarge`
// (blob-spill.ts); this wires it to the tool's per-run bucket/key options.
async function spillIfLarge<TDeps>(
  opts: CreateExtractTextToolOptions<TDeps>,
  deps: TDeps,
  args: ExtractTextArgs,
  result: ExtractTextResult,
): Promise<ExtractTextResult> {
  if (typeof result.text !== 'string') return result
  const spilled = await spillTextIfLarge(result.text, {
    bucket: (opts.getSpillBucket ?? opts.getBucket)(deps),
    key: opts.spillKey
      ? opts.spillKey(args, deps)
      : `${opts.spillKeyPrefix ?? DEFAULT_SPILL_PREFIX}${args.source}.extracted.txt`,
    threshold: opts.spillThreshold ?? DEFAULT_SPILL_THRESHOLD,
    previewChars: opts.previewChars ?? DEFAULT_PREVIEW_CHARS,
  })
  // Below threshold → identity string → nothing changed.
  if (typeof spilled === 'string') return result
  return { text: spilled, mode: result.mode, meta: { ...result.meta, spilled: true } }
}

/**
 * Build an `extract_text` registry entry. Register it in a host `toolRegistry`,
 * wiring the accessors to the host's R2 / Workers AI / Browser bindings.
 */
export function createExtractTextTool<TDeps>(
  opts: CreateExtractTextToolOptions<TDeps>,
): ToolRegistryEntry<TDeps> {
  const visionModel = opts.visionModel ?? DEFAULT_VISION_MODEL
  return {
    id: opts.id ?? 'extract_text',
    name: 'Extract Text',
    description: 'Extract text from an uploaded document.',
    icon: opts.icon,
    kind: 'function',
    inputSchema: extractTextInputSchema,
    outputSchema: extractTextOutputSchema,
    build:
      (deps) =>
      async (rawArgs): Promise<ExtractTextResult> => {
        const args = extractTextInputSchema.parse(rawArgs)
        // Spill any large extraction to R2 and return a pointer instead of the
        // inline text (transparent to downstream nodes).
        const finalize = (r: ExtractTextResult) =>
          spillIfLarge(opts, deps, args, r)
        const obj = await opts.getBucket(deps).get(args.source)
        if (!obj) {
          throw new Error(`extract_text: R2 object not found: ${args.source}`)
        }
        const bytes = new Uint8Array(await obj.arrayBuffer())

        if (isPlainText(args.mimeType, args.filename)) {
          return await finalize({
            text: new TextDecoder().decode(bytes),
            mode: 'passthrough',
            meta: { ocr: false },
          })
        }

        const ai = opts.getAI(deps)
        const markdown = await runToMarkdown(
          ai,
          args.filename,
          new Blob([bytes], { type: args.mimeType || undefined }),
        )

        const isPdf =
          args.mimeType === 'application/pdf' ||
          args.filename.toLowerCase().endsWith('.pdf')
        const wantOcr =
          Boolean(opts.getBrowser) &&
          isPdf &&
          (args.forceOcr === true || looksLikeScannedPdf(markdown))

        if (wantOcr && opts.getBrowser) {
          const recognize = opts.getRecognize
            ? opts.getRecognize(deps)
            : cloudflareVisionRecognizer(ai, visionModel)
          try {
            const { text, pages } = await ocrPdf(
              opts.getBrowser(deps),
              bytes,
              recognize,
            )
            if (text.length > 0) {
              return await finalize({
                text,
                mode: 'ocr',
                meta: { pages, ocr: true },
              })
            }
          } catch (err) {
            // OCR is best-effort — fall back to the toMarkdown output.
            return await finalize({
              text: markdown,
              mode: 'markdown',
              meta: {
                ocr: false,
                notes: `OCR failed: ${err instanceof Error ? err.message : String(err)}`,
              },
            })
          }
        }

        return await finalize({
          text: markdown,
          mode: 'markdown',
          meta: { ocr: false },
        })
      },
  }
}
