import {
  APICallError,
  type LanguageModelUsage,
  NoObjectGeneratedError,
  RetryError,
} from 'ai'

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
  /** The wrapped error's message — for a structured call, the parse or schema
   * complaint that explains WHY the output was rejected. */
  cause?: string
  /** Structured calls only: why the model stopped. `length` says the response
   * was cut off (the cap, or reasoning eating it) — a different bug entirely
   * from a model that answered in prose, which stops with `stop`. */
  finishReason?: string
  /** Structured calls only. `outputTokenDetails.reasoningTokens` against
   * `outputTokens` is what distinguishes "thought until it ran out of room to
   * answer" from "answered badly" — and it exists nowhere else once the error
   * has been stringified. */
  usage?: LanguageModelUsage
  /** Structured calls only: the raw text the model produced. Last field of the
   * serialized detail — see `MAX_TEXT`. */
  text?: string
}

// Cap on the serialized error stored in D1. The full request messages (e.g. a
// whole document) already live in `wf_run_step.input`, so we never need the
// error blob to be unbounded — the response body is the valuable part.
const MAX_STORED = 16_000

// The model's raw output is worth keeping on a structured failure — it's the
// only way to see what actually came back — but it's unbounded: an agent that
// answers in prose instead of JSON hands back its entire answer. Capped well
// under `MAX_STORED` so it can never crowd out the fields that explain the
// failure. (`text` is also serialized LAST, so the outer cap eats it first.)
const MAX_TEXT = 2_000

function cap(s: string, limit = MAX_STORED): string {
  return s.length > limit
    ? `${s.slice(0, limit)}…[truncated ${s.length - limit} chars]`
    : s
}

/**
 * Structured detail for an AI SDK error, or `null` for anything else.
 *
 * Two error shapes are read directly — `APICallError` (the provider rejected
 * the call) and `NoObjectGeneratedError` (it answered, but not with the object
 * the schema asked for). The latter used to fall through to the `cause` walk
 * below, which bottomed out at a bare `SyntaxError` and returned `null`: the
 * stored error was a stack and nothing else, and `finishReason` — the one field
 * that says whether the response was TRUNCATED or merely wrong — was dropped.
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
  // Deliberately no `isRetryable`: leaving it undefined keeps the dispatch's
  // step-level retry as the backstop for a one-off unparseable response.
  // Setting it `false` here would escalate to `NonRetryableError` and fail the
  // run on the first flake.
  if (NoObjectGeneratedError.isInstance(err)) {
    return {
      name: err.name,
      message: err.message,
      cause: err.cause instanceof Error ? cap(err.cause.message) : undefined,
      finishReason: err.finishReason,
      usage: err.usage,
      text: err.text == null ? undefined : cap(err.text, MAX_TEXT),
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
    // The finish reason is the whole diagnosis for a structured failure, and
    // it's short — the feed carries it rather than making a reader open the
    // stored blob to learn whether the response was simply cut off.
    const finish = d.finishReason ? ` (finish: ${d.finishReason})` : ''
    return `${d.name}: ${d.message}${status}${finish}${tries}`
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
