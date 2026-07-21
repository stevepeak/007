import { makeBlobRef, type WfBlobRef } from '../engine/blob-ref'

// The write-side of the blob-ref convention — the mirror of `blob-resolver.ts`.
// A tool that can produce a large text output (e.g. `extract_text`) spills it to
// R2 past a byte threshold and returns a `WfBlobRef` pointer instead, keeping the
// big string out of the node's recorded step output. Downstream nodes rehydrate
// the pointer transparently via the host's `resolveBlobRef` (`createR2BlobResolver`
// at the matching bucket). Any large-output tool can reuse this.

export type SpillTextOptions = {
  /** R2 bucket the spilled text is written to. */
  bucket: R2Bucket
  /** Full R2 key for the spilled object. */
  key: string
  /** Spill once the text's UTF-8 byte length exceeds this. */
  threshold: number
  /** Characters of the text kept inline on the pointer preview. */
  previewChars: number
}

/**
 * Write `text` to R2 and return a `WfBlobRef` pointer when it exceeds the byte
 * threshold; otherwise return the string unchanged (identity, so a caller can
 * cheaply detect "not spilled" with `typeof result === 'string'`).
 */
export async function spillTextIfLarge(
  text: string,
  opts: SpillTextOptions,
): Promise<string | WfBlobRef> {
  const byteLength = new TextEncoder().encode(text).length
  if (byteLength <= opts.threshold) return text
  await opts.bucket.put(opts.key, text, {
    httpMetadata: { contentType: 'text/plain; charset=utf-8' },
  })
  return makeBlobRef({
    key: opts.key,
    bytes: byteLength,
    chars: text.length,
    contentType: 'text/plain',
    preview: text.slice(0, opts.previewChars),
    storage: 'r2',
  })
}
