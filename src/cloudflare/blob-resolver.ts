import { isBlobRef, type WfBlobRef } from '../engine/blob-ref'
import type { BlobRefResolver } from '../engine/config'

// The Cloudflare side of the blob-ref convention (`../engine/blob-ref`): read a
// spilled payload back from R2. Wire the returned resolver into
// `WfSdkConfig.resolveBlobRef` so agent/tool nodes can rehydrate any pointer a
// tool (e.g. `extract_text`) returned in place of a large value.
//
// `R2Bucket` is an ambient `@cloudflare/workers-types` global.

export type CreateR2BlobResolverOptions<TDeps> = {
  /** R2 bucket the spilled bytes live in — pulled from the run deps. */
  getBucket: (deps: TDeps) => R2Bucket
}

/**
 * Build a {@link BlobRefResolver} that reads a blob ref's `key` from R2 and
 * returns the object's text. Only refs stored in R2 (`storage` unset or `'r2'`)
 * are handled; a foreign ref throws so misconfiguration surfaces loudly. A
 * missing object throws too — silently substituting the truncated `preview`
 * would feed a downstream node partial text while it believed it had the whole
 * document.
 */
export function createR2BlobResolver<TDeps>(
  opts: CreateR2BlobResolverOptions<TDeps>,
): BlobRefResolver<TDeps> {
  return async (ref: WfBlobRef, deps: TDeps): Promise<string> => {
    if (!isBlobRef(ref)) {
      throw new Error('createR2BlobResolver: value is not a blob ref.')
    }
    if (ref.storage && ref.storage !== 'r2') {
      throw new Error(
        `createR2BlobResolver: unsupported blob storage '${ref.storage}' for key ${ref.key}.`,
      )
    }
    const obj = await opts.getBucket(deps).get(ref.key)
    if (!obj) {
      throw new Error(`createR2BlobResolver: R2 object not found: ${ref.key}`)
    }
    return await obj.text()
  }
}
