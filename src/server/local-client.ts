import { createWfDataClient } from './data-client'
import type { WfDataClient } from './protocol'

// A `WfDataClient` for code running INSIDE the Worker that mounted the data
// handlers — the System Copilot, whose tools are the same ones `wf-mcp` exposes
// and are therefore written against the client interface, not against storage.
//
// It dispatches through the mounted handler with a synthetic request rather than
// calling the handler table directly, which costs a `Request` object and a JSON
// round-trip per call and buys the whole frame: per-method input validation, the
// `wf_change` actor binding, the 400/403/404/500 mapping and the host's
// `onError` hook. A second dispatch path would be a second place for those to be
// wrong.
//
// The synthetic request carries the ORIGINAL request's headers, so the host's
// `resolveContext` gate runs per call against the real caller's credentials. A
// copilot tool therefore cannot read anything the same user's browser could not
// ask for directly, and a session that expires mid-conversation stops answering.

export type LocalWfDataClientOptions = {
  /** The mounted dispatcher, from `createWfSdkHandlers`. */
  handler: (req: Request) => Promise<Response>
  /** The in-flight request whose credentials every dispatched call reuses. */
  request: Request
}

export function createLocalWfDataClient(
  opts: LocalWfDataClientOptions,
): WfDataClient {
  const headers = new Headers(opts.request.headers)
  headers.set('content-type', 'application/json')
  // The inherited length describes the ORIGINAL body; left in place it
  // contradicts the one being sent.
  headers.delete('content-length')

  return createWfDataClient(async (method, params) => {
    const res = await opts.handler(
      new Request(opts.request.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ method, params }),
      }),
    )
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error ?? `wf ${method} failed (${res.status})`)
    }
    return await res.json()
  })
}
