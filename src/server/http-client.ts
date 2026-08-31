import { createWfDataClient } from './data-client'
import type { WfDataClient } from './protocol'

// Browser-side data client — talks to the host-mounted `createWfSdkHandlers`
// route over the one-POST RPC protocol. Injected into the UI via `WfSdkProvider`,
// and used by `wf-mcp` to reach a host it isn't running inside.
//
// Only the transport lives here; which method takes what, and which ones need a
// longer budget, is `data-client.ts`.

export type HttpWfDataClientOptions = {
  /** URL of the mounted handler route, e.g. '/api/wf'. */
  baseUrl: string
  /** Override fetch (SSR, auth wrappers). Defaults to global fetch. */
  fetch?: typeof fetch
  /** Extra headers on every request (auth tokens, etc.). */
  headers?: Record<string, string>
  /** Per-call hard timeout (ms) so no request can hang the UI. Default 20000. */
  timeoutMs?: number
}

export function createHttpWfDataClient(
  opts: HttpWfDataClientOptions,
): WfDataClient {
  const doFetch = opts.fetch ?? fetch

  return createWfDataClient(async (method, params, timeoutMs) => {
    // Hard backstop: no single call may hang the UI indefinitely. If the
    // response never arrives (dev-proxy buffering, a stalled connection), abort
    // so the caller settles with an error instead of an eternal spinner.
    const res = await doFetch(opts.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...opts.headers },
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(timeoutMs ?? opts.timeoutMs ?? 20000),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error ?? `wf-sdk request failed (${res.status})`)
    }
    return await res.json()
  })
}
