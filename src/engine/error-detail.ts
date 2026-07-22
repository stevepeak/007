import { APICallError } from 'ai'

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

/** Structured detail for an AI SDK API error, or `null` for anything else. */
export function apiErrorDetail(err: unknown): ApiErrorDetail | null {
  if (!APICallError.isInstance(err)) return null
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

/**
 * Short one-line summary for the run feed / node-end line. Keeps the human feed
 * readable — the full body goes to `errorStored` and Sentry, not here.
 */
export function errorFeedLine(err: unknown): string {
  const d = apiErrorDetail(err)
  if (d) {
    return `${d.name}: ${d.message}${d.statusCode ? ` (HTTP ${d.statusCode})` : ''}`
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
