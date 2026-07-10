// Blob-ref convention — the SDK's answer to "a node produced a value too big to
// pass between steps." A node can return a **pointer** to externally-stored bytes
// instead of the bytes themselves; a downstream node rehydrates the pointer to
// its real value *inside its own step*, so the large payload never sits at a
// step boundary (where Cloudflare Workflows caps output size and the run
// recorder would persist it in full).
//
// The engine stays provider-agnostic: it only knows the marker *shape* and how
// to walk a value replacing markers. The actual read (R2, KV, S3, …) is an
// injected `resolveBlobRef` on the host `WfSdkConfig` — see
// `createR2BlobResolver` in `../cloudflare` for the Cloudflare wiring.

/** Discriminating property that tags a value as a blob pointer. */
export const WF_BLOB_REF_TAG = '__wfBlobRef' as const

/**
 * A pointer to externally-stored bytes, returned in place of a large value.
 * `key` is opaque to the engine — the host `resolveBlobRef` interprets it (an R2
 * object key, a KV name, …). The remaining fields are advisory metadata for
 * budgeting, traces, and UI, so a viewer can show something without a fetch.
 */
export type WfBlobRef = {
  readonly __wfBlobRef: true
  /** Opaque storage key the host resolver reads (e.g. an R2 object key). */
  key: string
  /** Byte size of the stored payload, when known. */
  bytes?: number
  /** Character length of the stored text, when the payload is text. */
  chars?: number
  /** MIME type of the stored payload (default `text/plain`). */
  contentType?: string
  /** A short inline preview (first N chars) shown in traces without a fetch. */
  preview?: string
  /** Host storage hint (e.g. `r2`, `kv`); opaque to the engine. */
  storage?: string
}

/** Narrow an unknown value to a {@link WfBlobRef}. */
export function isBlobRef(value: unknown): value is WfBlobRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[WF_BLOB_REF_TAG] === true &&
    typeof (value as { key?: unknown }).key === 'string'
  )
}

/** Construct a well-formed {@link WfBlobRef} (stamps the discriminant tag). */
export function makeBlobRef(init: Omit<WfBlobRef, '__wfBlobRef'>): WfBlobRef {
  return { [WF_BLOB_REF_TAG]: true, ...init }
}

/** Resolves a single blob ref to its real (text) value. */
export type BlobRehydrate = (ref: WfBlobRef) => Promise<string>

/**
 * Deep-walk `value`, replacing every {@link WfBlobRef} with its resolved text.
 * A bare ref resolves to a string; a ref nested in an object/array is replaced
 * in place (so binding a whole upstream output still rehydrates). Non-ref
 * values pass through untouched. Runs the resolutions concurrently.
 */
export async function rehydrateBlobRefs(
  value: unknown,
  resolve: BlobRehydrate,
): Promise<unknown> {
  if (isBlobRef(value)) return await resolve(value)
  if (Array.isArray(value)) {
    return await Promise.all(value.map((v) => rehydrateBlobRefs(v, resolve)))
  }
  if (value !== null && typeof value === 'object') {
    const entries = await Promise.all(
      Object.entries(value).map(
        async ([k, v]) => [k, await rehydrateBlobRefs(v, resolve)] as const,
      ),
    )
    return Object.fromEntries(entries)
  }
  return value
}
