import type { StartGraphRunInput, StartGraphRunResult } from './start-run'

/**
 * The version-based run-starting contract: start a durable run from a specific
 * `workflowVersionId`. The workflows Worker implements it both as a
 * service-binding RPC (prod / `wrangler dev`) and as `POST /graph-runs` (the
 * local-dev HTTP fallback when the service binding isn't wired, e.g. `next dev`).
 * Type your service binding against this so the binding and the HTTP fallback
 * are interchangeable at the call site.
 */
export interface WfGraphRunClient {
  startGraphRun(input: StartGraphRunInput): Promise<StartGraphRunResult>
}

export type HttpGraphRunClientOptions = {
  /** Base URL of the workflows Worker, e.g. 'http://localhost:8787'. */
  baseUrl: string
  /** Override fetch (SSR, auth wrappers). Defaults to global fetch. */
  fetch?: typeof fetch
  /** Extra headers on every request. */
  headers?: Record<string, string>
}

/**
 * HTTP implementation of {@link WfGraphRunClient} against the Worker's
 * `POST /graph-runs` route. Import-safe from any server runtime (fetch only) —
 * both hosts previously hand-rolled this. Note this is the **version-based**
 * contract; a host that resolves the workflow version Worker-side (from a
 * trigger kind) exposes a different route and should not use this client.
 */
export function createHttpGraphRunClient(
  opts: HttpGraphRunClientOptions,
): WfGraphRunClient {
  const doFetch = opts.fetch ?? fetch
  return {
    async startGraphRun(input) {
      const res = await doFetch(`${opts.baseUrl}/graph-runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...opts.headers },
        body: JSON.stringify(input),
      })
      if (!res.ok) {
        throw new Error(`workflows worker returned ${res.status}`)
      }
      const result: StartGraphRunResult = await res.json()
      return result
    },
  }
}
