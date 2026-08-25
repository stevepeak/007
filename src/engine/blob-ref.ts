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

/**
 * Whether `value` contains a {@link WfBlobRef} anywhere inside it. Lets a caller
 * skip the cost of preparing a rehydrate (building run deps, opening a client)
 * for the overwhelmingly common value that has nothing spilled in it. Bails at
 * the first hit rather than walking the whole structure.
 */
export function hasBlobRef(value: unknown): boolean {
  if (isBlobRef(value)) return true
  if (Array.isArray(value)) return value.some(hasBlobRef)
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(hasBlobRef)
  }
  return false
}

/** Construct a well-formed {@link WfBlobRef} (stamps the discriminant tag). */
export function makeBlobRef(init: Omit<WfBlobRef, '__wfBlobRef'>): WfBlobRef {
  return { [WF_BLOB_REF_TAG]: true, ...init }
}

/** Resolves a single blob ref to its real (text) value. */
export type BlobRehydrate = (ref: WfBlobRef) => Promise<string>

/**
 * Content type stamped on a ref whose payload is the JSON encoding of a
 * non-string value. {@link rehydrateBlobRefs} parses it back, so spilling is
 * type-preserving: an object goes out and the same object comes back, not the
 * string it was stored as.
 */
export const WF_BLOB_JSON_CONTENT_TYPE = 'application/json' as const

/**
 * Deep-walk `value`, replacing every {@link WfBlobRef} with its resolved value.
 * A bare ref resolves to its payload; a ref nested in an object/array is
 * replaced in place (so binding a whole upstream output still rehydrates).
 * Non-ref values pass through untouched. Runs the resolutions concurrently.
 *
 * The host resolver always hands back **text** (that's all a byte store knows).
 * A ref tagged {@link WF_BLOB_JSON_CONTENT_TYPE} is parsed back to the value it
 * was made from — without that, a spilled object would rehydrate as a JSON
 * string and every downstream `ref(node, 'field')` would silently miss.
 */
export async function rehydrateBlobRefs(
  value: unknown,
  resolve: BlobRehydrate,
): Promise<unknown> {
  if (isBlobRef(value)) {
    const text = await resolve(value)
    if (value.contentType !== WF_BLOB_JSON_CONTENT_TYPE) return text
    try {
      return JSON.parse(text) as unknown
    } catch (err) {
      throw new Error(
        `rehydrateBlobRefs: blob ${value.key} is tagged ${WF_BLOB_JSON_CONTENT_TYPE} but did not parse: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }
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

// ── Write side ──────────────────────────────────────────────────────────────
//
// The mirror of `rehydrateBlobRefs`: find the parts of a value too big to cross
// a step boundary and replace them with pointers. The engine owns the *policy*
// (what counts as large, how a payload is encoded, what metadata the pointer
// carries); the host owns the *write* — see `createR2BlobSpiller` in
// `../cloudflare` for the Cloudflare implementation.
//
// Spilling LEAVES, not the whole value, is the load-bearing decision here.
// A graph binds `ref(node, 'text')`, and `resolveBinding` walks that path
// through the recorded output before anything gets a chance to rehydrate — so
// swapping a whole `{ text, mode, meta }` object for one pointer would leave
// every path-ref into it resolving to `undefined`. Silently: the run would keep
// going and hand the next node nothing. Replacing just the oversized `text`
// keeps the shape intact, the path resolvable, and the pointer exactly where a
// consumer already knows how to rehydrate it — which is also, not by accident,
// the shape `extract_text` has returned since before any of this was generic.

/** Writes a spilled payload and reports where it landed. Host-injected. */
export type BlobWrite = (payload: {
  /** The bytes to store, already encoded. */
  text: string
  /** `text/plain` for a string leaf, `application/json` for anything else. */
  contentType: string
  /** Where in the value this payload came from, e.g. `text` or `items.3.body`. */
  path: string
}) => Promise<{ key: string; storage?: string }>

export type SpillOptions = {
  /** Spill a string leaf once its UTF-8 byte length exceeds this. */
  thresholdBytes: number
  /** Characters of the payload kept inline on the pointer preview. */
  previewChars: number
  write: BlobWrite
}

/**
 * Deep-walk `value` and replace every oversized string leaf with a
 * {@link WfBlobRef} pointer. Structure, keys and array positions are preserved,
 * so any binding that pointed into this value still resolves — to a pointer
 * where it used to reach a huge string, which {@link rehydrateBlobRefs} reads
 * back inside the consuming node's own step.
 *
 * Returns the value unchanged when nothing needed spilling, so the common case
 * allocates nothing.
 */
export async function spillLargeLeaves(
  value: unknown,
  opts: SpillOptions,
): Promise<unknown> {
  return await spillAt(value, opts, '')
}

async function spillAt(
  value: unknown,
  opts: SpillOptions,
  path: string,
): Promise<unknown> {
  if (isBlobRef(value)) return value
  if (typeof value === 'string') {
    const bytes = utf8Length(value)
    if (bytes <= opts.thresholdBytes) return value
    const written = await opts.write({
      text: value,
      contentType: 'text/plain',
      path,
    })
    return makeBlobRef({
      key: written.key,
      bytes,
      chars: value.length,
      contentType: 'text/plain',
      preview: value.slice(0, opts.previewChars),
      storage: written.storage,
    })
  }
  if (Array.isArray(value)) {
    return await Promise.all(
      value.map((v, i) => spillAt(v, opts, joinPath(path, String(i)))),
    )
  }
  if (value !== null && typeof value === 'object') {
    const entries = await Promise.all(
      Object.entries(value).map(
        async ([k, v]) => [k, await spillAt(v, opts, joinPath(path, k))] as const,
      ),
    )
    return Object.fromEntries(entries)
  }
  return value
}

function joinPath(path: string, segment: string): string {
  return path ? `${path}.${segment}` : segment
}

/**
 * UTF-8 byte length of a value's JSON encoding — what a step boundary actually
 * measures. `undefined` when the value cannot be encoded at all (a cycle, a
 * BigInt); the boundary will reject it on its own terms, more clearly than a
 * guess here could.
 */
export function encodedByteLength(value: unknown): number | undefined {
  try {
    const json = JSON.stringify(value)
    // `JSON.stringify(undefined)` is `undefined`, which is a legitimate empty
    // output rather than an encoding failure.
    return json === undefined ? 0 : utf8Length(json)
  } catch {
    return undefined
  }
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length
}
