import { makeBlobRef, type WfBlobRef } from '../engine/blob-ref'
import type { BlobSpillContext, BlobSpiller } from '../engine/config'

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


// ── The generic spiller ─────────────────────────────────────────────────────
//
// `spillTextIfLarge` above is the per-tool entry point: a tool that KNOWS it can
// produce a large value calls it with a key it derives itself. The spiller below
// is the other half — wired once into `WfSdkConfig.spillBlobRef`, it catches
// every node output at the dispatch boundary whether or not the node that
// produced it knew it might be big. The engine has already measured the payload
// and chosen its encoding by the time this runs; all that's left is the write.

export type CreateR2BlobSpillerOptions<TDeps> = {
  /** R2 bucket spilled payloads are written to — pulled from the run deps. */
  getBucket: (deps: TDeps) => R2Bucket
  /**
   * Full R2 key for the spilled object. Called once per spill; must be
   * deterministic in its arguments, because a retried step re-runs the write
   * and a fresh key each time would leak an object per attempt.
   *
   * This is where multi-tenant layout belongs: give the key a tenant-scoped
   * prefix and one prefix-scoped R2 lifecycle rule can expire (or one prefix
   * delete can purge) a tenant's spills.
   */
  key: (ctx: BlobSpillContext, deps: TDeps) => string
}

/**
 * Build a {@link BlobSpiller} that writes spilled payloads to R2. The mirror of
 * `createR2BlobResolver` — wire both, from the same bucket, or neither.
 */
export function createR2BlobSpiller<TDeps>(
  opts: CreateR2BlobSpillerOptions<TDeps>,
): BlobSpiller<TDeps> {
  return async (payload, ctx, deps) => {
    const key = opts.key(ctx, deps)
    await opts.getBucket(deps).put(key, payload.text, {
      httpMetadata: { contentType: `${payload.contentType}; charset=utf-8` },
    })
    return { key, storage: 'r2' }
  }
}
