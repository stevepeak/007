// The PDF-rasterization + vision-OCR engine behind `extract_text`, split out so
// it can be reused (or its vision seam overridden) independently of the tool's
// R2/spill orchestration. Given a PDF's bytes + a Browser-Rendering binding it
// rasterizes every page to a PNG (headless PDF.js), then runs each page image
// through a pluggable recognizer. Render and OCR are deliberately separate
// passes — holding the browser WS open across slow vision calls caused "Network
// connection lost" errors.

const OCR_PROMPT =
  'You are an OCR engine. Extract all text from this document page exactly as it appears, preserving line breaks and table layout where reasonable. Output only the raw text — no preamble, no explanation, no markdown fences.'

const PDFJS_VERSION = '4.7.76'
const PDFJS_LIB_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/legacy/build/pdf.min.mjs`
const PDFJS_WORKER_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/legacy/build/pdf.worker.min.mjs`
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

/** Rasterize a PDF and OCR every page, joined into one text blob. */
export async function ocrPdf(
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
