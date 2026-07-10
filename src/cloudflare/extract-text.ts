import { z } from 'zod'

import { makeBlobRef, type WfBlobRef } from '../engine/blob-ref'
import type { ToolRegistryEntry } from '../engine/tool-registry'

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

const OCR_PROMPT =
  'You are an OCR engine. Extract all text from this document page exactly as it appears, preserving line breaks and table layout where reasonable. Output only the raw text — no preamble, no explanation, no markdown fences.'

const PDFJS_VERSION = '4.7.76'
const PDFJS_LIB_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/legacy/build/pdf.min.mjs`
const PDFJS_WORKER_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/legacy/build/pdf.worker.min.mjs`
const PAGE_RENDER_SCALE = 1.5
const MAX_OCR_PAGES = 50
// A capable image-to-text model on Workers AI; override via `visionModel`.
const DEFAULT_VISION_MODEL = '@cf/llava-hf/llava-1.5-7b-hf'
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

// A rendered page (PNG bytes) → recognized text. Hosts can plug in Venice,
// OpenAI, etc.; when omitted the tool uses Cloudflare Workers AI vision.
export type OcrRecognize = (
  pngBytes: Uint8Array,
  page: number,
) => Promise<string>

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

/** Default OCR recognizer: a Workers AI vision model (`{ image, prompt }`). */
export function cloudflareVisionRecognizer(
  ai: Ai,
  model: string,
): OcrRecognize {
  const run = (
    ai as unknown as { run: (m: string, i: unknown) => Promise<unknown> }
  ).run
  return async (png) => {
    const res = (await run.call(ai, model, {
      image: Array.from(png),
      prompt: OCR_PROMPT,
    })) as { description?: string } | string
    return typeof res === 'string' ? res : (res.description ?? '')
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x2000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

// Load PDF.js in a headless browser, rasterize every page to a PNG, then close
// the browser before returning (holding the WS open across slow vision calls
// caused "Network connection lost" errors, so render and OCR are separate).
async function renderPdfPages(
  browserBinding: Fetcher,
  pdfBytes: Uint8Array,
): Promise<Uint8Array[]> {
  // Lazy import: keep `@cloudflare/puppeteer` (and any Worker-only modules it
  // may pull) out of module-load so this tool imports cleanly in Node contexts
  // (e.g. the web app's editor). It only loads when OCR actually runs.
  const { default: puppeteer } = await import('@cloudflare/puppeteer')
  const browser = await puppeteer.launch(browserBinding)
  try {
    const page = await browser.newPage()
    await page.setContent(buildRendererHtml(), {
      waitUntil: 'domcontentloaded',
    })
    const numPages = await page.evaluate((b64: string) => {
      const w = window as unknown as {
        __renderPdf: (b: string) => Promise<number>
      }
      return w.__renderPdf(b64)
    }, toBase64(pdfBytes))
    if (!numPages || numPages < 1) return []

    const pageCount = Math.min(numPages, MAX_OCR_PAGES)
    const buffers: Uint8Array[] = []
    for (let i = 1; i <= pageCount; i++) {
      const canvas = await page.$(`#page-${i}`)
      if (!canvas) {
        buffers.push(new Uint8Array())
        continue
      }
      buffers.push(await canvas.screenshot({ type: 'png' }))
    }
    return buffers
  } finally {
    await browser.close().catch(() => {
      // Don't let cleanup failures shadow the real error.
    })
  }
}

async function ocrPdf(
  browserBinding: Fetcher,
  pdfBytes: Uint8Array,
  recognize: OcrRecognize,
): Promise<{ text: string; pages: number }> {
  const pages = await renderPdfPages(browserBinding, pdfBytes)
  const out: string[] = []
  for (let i = 0; i < pages.length; i++) {
    const png = pages[i]
    if (!png || png.length === 0) {
      out.push('')
      continue
    }
    try {
      out.push((await recognize(png, i + 1)).trim())
    } catch {
      // A single-page OCR failure shouldn't sink the whole document.
      out.push('')
    }
  }
  const text = out
    .map((t, i) => `--- Page ${i + 1} ---\n${t}`)
    .join('\n\n')
    .trim()
  return { text, pages: pages.length }
}

// When the freshly extracted text is larger than the spill threshold, write it
// to R2 and swap the inline string for a `WfBlobRef` pointer; otherwise return
// it unchanged. Keeps the big string out of the node's step output — downstream
// nodes rehydrate the pointer via the host `resolveBlobRef`.
async function spillIfLarge<TDeps>(
  opts: CreateExtractTextToolOptions<TDeps>,
  deps: TDeps,
  args: ExtractTextArgs,
  result: ExtractTextResult,
): Promise<ExtractTextResult> {
  if (typeof result.text !== 'string') return result
  const threshold = opts.spillThreshold ?? DEFAULT_SPILL_THRESHOLD
  const byteLength = new TextEncoder().encode(result.text).length
  if (byteLength <= threshold) return result

  const bucket = (opts.getSpillBucket ?? opts.getBucket)(deps)
  const key = opts.spillKey
    ? opts.spillKey(args, deps)
    : `${opts.spillKeyPrefix ?? DEFAULT_SPILL_PREFIX}${args.source}.extracted.txt`
  await bucket.put(key, result.text, {
    httpMetadata: { contentType: 'text/plain; charset=utf-8' },
  })
  const previewChars = opts.previewChars ?? DEFAULT_PREVIEW_CHARS
  return {
    text: makeBlobRef({
      key,
      bytes: byteLength,
      chars: result.text.length,
      contentType: 'text/plain',
      preview: result.text.slice(0, previewChars),
      storage: 'r2',
    }),
    mode: result.mode,
    meta: { ...result.meta, spilled: true },
  }
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

function buildRendererHtml(): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><style>body{margin:0;background:#fff} canvas{display:block}</style></head>
<body>
<div id="pages"></div>
<script type="module">
import * as pdfjsLib from ${JSON.stringify(PDFJS_LIB_URL)};
pdfjsLib.GlobalWorkerOptions.workerSrc = ${JSON.stringify(PDFJS_WORKER_URL)};

window.__renderPdf = async (b64) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const container = document.getElementById('pages');
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: ${PAGE_RENDER_SCALE} });
    const canvas = document.createElement('canvas');
    canvas.id = 'page-' + i;
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    container.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  }
  return pdf.numPages;
};
</script>
</body>
</html>`
}
