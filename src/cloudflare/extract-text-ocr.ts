// The PDF-rasterization + vision-OCR engine behind `extract_text`, split out so
// it can be reused (or its vision seam overridden) independently of the tool's
// R2/spill orchestration. Given a PDF's bytes + a Browser-Rendering binding it
// rasterizes every page to a PNG (headless PDF.js), then runs each page image
// through a pluggable recognizer. Render and OCR are deliberately separate
// passes — holding the browser WS open across slow vision calls caused "Network
// connection lost" errors.

// Type-only (erased at compile time), so `@cloudflare/puppeteer` still stays out
// of module load — see the lazy `import()` in `renderPdfPages`. Naming the exact
// binding `launch` requires is also more honest than `Fetcher`: not every
// Fetcher is a Browser-Rendering binding.
import type { BrowserWorker } from '@cloudflare/puppeteer'

const OCR_PROMPT =
  'You are an OCR engine. Extract all text from this document page exactly as it appears, preserving line breaks and table layout where reasonable. Output only the raw text — no preamble, no explanation, no markdown fences.'

/**
 * The PDF.js release this renderer is written against. Exported so a host can
 * build a matching self-hosted asset path (and assert its pinned `pdfjs-dist`
 * dependency hasn't drifted from what the injected script expects).
 */
export const PDFJS_VERSION = '6.2.108'

/**
 * Where the injected page loads PDF.js from — the URL of a served *copy of the
 * `pdfjs-dist` package root*, i.e. a directory holding `legacy/build/`,
 * `wasm/` and `iccs/`.
 *
 * It is the package root rather than `legacy/build/` because since PDF.js 5
 * the decoders are WebAssembly and live in a *sibling* directory of the
 * bundles: JPEG 2000 (`openjpeg.wasm`), JBIG2/CCITT (`jbig2.wasm`, the
 * encoding most scanned and faxed documents use) and ICC colour conversion
 * (`qcms_bg.wasm`). Deriving every URL from one root keeps `wasmUrl`/`iccUrl`
 * in {@link buildRendererHtml} from having to climb out of the build dir.
 *
 * Defaults to jsDelivr so the SDK works with zero wiring, but a host serving
 * privileged documents should override it (`getPdfjsBaseUrl` on the tool) to
 * point at its own origin: this script runs in a page holding the document's
 * bytes, so whatever this URL returns executes against them, and an `import`
 * specifier cannot carry a subresource-integrity hash.
 */
const DEFAULT_PDFJS_BASE_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/`
/** How long the page gets to fetch + evaluate the PDF.js module script. */
const PDFJS_LOAD_TIMEOUT_MS = 15_000
const PAGE_RENDER_SCALE = 1.5
const MAX_OCR_PAGES = 50
// A capable image-to-text model on Workers AI; override via `visionModel`.
export const DEFAULT_VISION_MODEL = '@cf/llava-hf/llava-1.5-7b-hf'

// A rendered page (PNG bytes) → recognized text. Hosts can plug in Venice,
// OpenAI, etc.; when omitted the tool uses Cloudflare Workers AI vision.
export type OcrRecognize = (
  pngBytes: Uint8Array,
  page: number,
) => Promise<string>

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
  browserBinding: BrowserWorker,
  pdfBytes: Uint8Array,
  pdfjsBaseUrl: string,
): Promise<Uint8Array[]> {
  // Lazy import: keep `@cloudflare/puppeteer` (and any Worker-only modules it
  // may pull) out of module-load so this tool imports cleanly in Node contexts
  // (e.g. the web app's editor). It only loads when OCR actually runs.
  const { default: puppeteer } = await import('@cloudflare/puppeteer')
  const browser = await puppeteer.launch(browserBinding)
  try {
    const page = await browser.newPage()
    await page.setContent(buildRendererHtml(pdfjsBaseUrl), {
      waitUntil: 'domcontentloaded',
    })
    // `domcontentloaded` fires before the module script has fetched and run, so
    // wait for the script to actually settle — otherwise a slow PDF.js load
    // races the `evaluate` below and surfaces as a bare
    // "__renderPdf is not a function".
    await page
      .waitForFunction(
        'typeof window.__renderPdf === "function" || typeof window.__pdfjsError === "string"',
        { timeout: PDFJS_LOAD_TIMEOUT_MS },
      )
      .catch(() => {
        throw new Error(
          `PDF.js did not load from ${pdfjsBaseUrl} within ${PDFJS_LOAD_TIMEOUT_MS}ms`,
        )
      })
    const loadError = await page.evaluate(
      () => (window as unknown as { __pdfjsError?: string }).__pdfjsError ?? '',
    )
    if (loadError) {
      throw new Error(`PDF.js failed to load from ${pdfjsBaseUrl}: ${loadError}`)
    }
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

/** Rasterize a PDF and OCR every page, joined into one text blob. */
export async function ocrPdf(
  browserBinding: BrowserWorker,
  pdfBytes: Uint8Array,
  recognize: OcrRecognize,
  opts?: {
    /**
     * URL of a served copy of the `pdfjs-dist` package root — it must expose
     * `legacy/build/`, `wasm/` and `iccs/`. Defaults to jsDelivr; see
     * {@link DEFAULT_PDFJS_BASE_URL} for why hosts should override it, and why
     * this is the package root rather than the build directory.
     */
    pdfjsBaseUrl?: string
  },
): Promise<{ text: string; pages: number }> {
  const pages = await renderPdfPages(
    browserBinding,
    pdfBytes,
    opts?.pdfjsBaseUrl ?? DEFAULT_PDFJS_BASE_URL,
  )
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

/**
 * The page injected into Browser Rendering. Exported for
 * `extract-text-ocr.test.ts`, which asserts the decoder URLs stay wired — a
 * missing `wasmUrl` fails silently at runtime (see the comment on the
 * `getDocument` call below), so it needs a build-time guard.
 */
export function buildRendererHtml(pdfjsBaseUrl: string): string {
  // A directory URL, so the sub-paths below concatenate cleanly. PDF.js also
  // rejects `wasmUrl`/`iccUrl` values that lack a trailing slash outright
  // ("Invalid factory url"), so the normalisation is load-bearing, not tidiness.
  const base = pdfjsBaseUrl.endsWith('/') ? pdfjsBaseUrl : `${pdfjsBaseUrl}/`
  // `import()` rather than a static `import` so a failed fetch is catchable: a
  // static import that 404s kills the whole module, leaving neither
  // `__renderPdf` nor `__pdfjsError` defined and the Worker with nothing but a
  // timeout to report.
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><style>body{margin:0;background:#fff} canvas{display:block}</style></head>
<body>
<div id="pages"></div>
<script type="module">
try {
  const pdfjsLib = await import(${JSON.stringify(`${base}legacy/build/pdf.min.mjs`)});
  pdfjsLib.GlobalWorkerOptions.workerSrc = ${JSON.stringify(`${base}legacy/build/pdf.worker.min.mjs`)};

  window.__renderPdf = async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // \`wasmUrl\` is not optional for our workload: PDF.js 6 decodes JBIG2 and
    // JPEG 2000 images through WebAssembly, and when it can't fetch the module
    // it only \`warn()\`s and leaves the image undecoded. Scanned documents —
    // exactly what reaches this OCR path — are overwhelmingly JBIG2, so
    // omitting this yields blank pages and empty OCR text with no error.
    const pdf = await pdfjsLib.getDocument({
      data: bytes,
      wasmUrl: ${JSON.stringify(`${base}wasm/`)},
      iccUrl: ${JSON.stringify(`${base}iccs/`)},
    }).promise;
    const container = document.getElementById('pages');
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: ${PAGE_RENDER_SCALE} });
      const canvas = document.createElement('canvas');
      canvas.id = 'page-' + i;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      container.appendChild(canvas);
      // Hand PDF.js the canvas rather than a context we made: since 6.x it
      // creates the context itself with \`{ alpha: false, willReadFrequently }\`,
      // which is what we want for an opaque page we immediately screenshot.
      await page.render({ canvas, viewport }).promise;
    }
    return pdf.numPages;
  };
} catch (e) {
  window.__pdfjsError = String((e && e.message) || e);
}
</script>
</body>
</html>`
}
