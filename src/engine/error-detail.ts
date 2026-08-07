import { APICallError, RetryError } from 'ai'

// When an agent/tool node's model call fails, the thrown value is usually an
// AI SDK `APICallError` whose `.message` is a bare "Bad Request". The one thing
// we actually need to debug it — the provider's response body, the status code,
// and what we sent — hangs off the error object and is lost the moment we
// stringify `.message`. These helpers keep that detail so it survives into
// `wf_run_step.error` and the Sentry issue.

export interface ApiErrorDetail {
  name: string
  message: string
  statusCode?: number
  url?: string
  responseBody?: string
  requestBodyValues?: unknown
  isRetryable?: boolean
  data?: unknown
  /** Provider attempts the SDK made before giving up, when it retried. */
  attempts?: number
  /** Why the retry wrapper gave up: maxRetriesExceeded | errorNotRetryable | abort. */
  retryReason?: string
}

// Cap on the serialized error stored in D1. The full request messages (e.g. a
// whole document) already live in `wf_run_step.input`, so we never need the
// error blob to be unbounded — the response body is the valuable part.
const MAX_STORED = 16_000

function cap(s: string): string {
  return s.length > MAX_STORED
    ? `${s.slice(0, MAX_STORED)}…[truncated ${s.length - MAX_STORED} chars]`
    : s
}

/**
 * Structured detail for an AI SDK API error, or `null` for anything else.
 *
 * Unwraps two kinds of wrapper:
 *
 * - `cause`: the Cloudflare dispatch re-throws a fatal provider error as a
 *   `NonRetryableError` (so the workflow stops retrying something that will
 *   never succeed) with the original hanging off `cause`.
 * - `RetryError`: the AI SDK's own retry wrapper. It does NOT use `cause` — it
 *   keeps every attempt on `.errors` and the decisive one on `.lastError`. Any
 *   retried call therefore arrives here as an `AI_RetryError` whose message is
 *   just "Failed after 3 attempts", and following `cause` alone found nothing:
 *   the provider's status code and response body were silently dropped from
 *   `wf_run_step.error` and the Sentry `ai_api_call` context. It also meant
 *   `isRetryable === false` could never surface for a wrapped fatal error, so
 *   the dispatch's `NonRetryableError` escalation never fired for one.
 */
export function apiErrorDetail(
  err: unknown,
  // Depth-capped so a self-referential `cause` can't spin.
  depth = 4,
): ApiErrorDetail | null {
  if (APICallError.isInstance(err)) {
    return {
      name: err.name,
      message: err.message,
      statusCode: err.statusCode,
      url: err.url,
      responseBody: err.responseBody ?? undefined,
      requestBodyValues: err.requestBodyValues,
      isRetryable: err.isRetryable,
      data: err.data,
    }
  }
  if (depth <= 0) return null
  if (RetryError.isInstance(err)) {
    // `lastError` first — it's the attempt that decided the outcome — then the
    // rest, so a run whose final attempt threw something opaque still surfaces
    // an earlier provider rejection rather than nothing at all.
    for (const nested of [err.lastError, ...(err.errors ?? [])]) {
      if (nested == null) continue
      const d = apiErrorDetail(nested, depth - 1)
      if (d) {
        return { ...d, attempts: err.errors?.length, retryReason: err.reason }
      }
    }
    return null
  }
  const cause = (err as { cause?: unknown } | null | undefined)?.cause
  return cause == null ? null : apiErrorDetail(cause, depth - 1)
}

/**
 * Short one-line summary for the run feed / node-end line. Keeps the human feed
 * readable — the full body goes to `errorStored` and Sentry, not here.
 */
export function errorFeedLine(err: unknown): string {
  const d = apiErrorDetail(err)
  if (d) {
    const status = d.statusCode ? ` (HTTP ${d.statusCode})` : ''
    // Name the attempt count when the SDK retried, so the feed distinguishes a
    // one-off rejection from a provider that refused repeatedly.
    const tries = d.attempts && d.attempts > 1 ? ` after ${d.attempts} attempts` : ''
    return `${d.name}: ${d.message}${status}${tries}`
  }
  return err instanceof Error ? err.message : String(err)
}

/**
 * Full value to persist in `wf_run_step.error`. For API errors this is pretty
 * JSON that includes the provider response body (the actual rejection reason);
 * for everything else it's the stack (or message). Always length-capped.
 */
export function errorStored(err: unknown): string {
  const d = apiErrorDetail(err)
  if (d) return cap(JSON.stringify(d, null, 2))
  if (err instanceof Error) return cap(err.stack ?? err.message)
  return cap(String(err))
}
