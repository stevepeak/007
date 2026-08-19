import { describe, expect, test } from 'bun:test'

import { buildRendererHtml } from './extract-text-ocr'

// Since PDF.js 5 the image decoders are WebAssembly modules fetched at runtime
// from `wasmUrl`, and since 6 that includes JBIG2/CCITT — the encodings scanned
// and faxed documents use, i.e. every input that reaches this OCR path. When the
// option is missing PDF.js only `warn()`s and leaves the image undecoded, so the
// page rasterizes blank and OCR returns empty text with nothing thrown and a
// green build. These assertions are the guard against that regressing silently.
describe('buildRendererHtml', () => {
  const base = 'https://example.test/pdfjs/'
  const html = buildRendererHtml(base)

  test('loads both bundles from the package root', () => {
    expect(html).toContain(`"${base}legacy/build/pdf.min.mjs"`)
    expect(html).toContain(`"${base}legacy/build/pdf.worker.min.mjs"`)
  })

  test('passes the decoder + colour-profile directories to getDocument', () => {
    expect(html).toContain(`wasmUrl: "${base}wasm/"`)
    expect(html).toContain(`iccUrl: "${base}iccs/"`)
  })

  test('normalizes a base URL missing its trailing slash', () => {
    // PDF.js throws "Invalid factory url" on a `wasmUrl` without one, so a host
    // returning an unslashed base must not take the whole page down.
    const unslashed = buildRendererHtml('https://example.test/pdfjs')
    expect(unslashed).toContain('wasmUrl: "https://example.test/pdfjs/wasm/"')
  })

  test('renders via the canvas parameter, not a self-made context', () => {
    // 6.x creates the context itself with `{ alpha: false }`, which is what we
    // want for an opaque page that is screenshotted immediately.
    expect(html).toContain('page.render({ canvas, viewport })')
  })
})
