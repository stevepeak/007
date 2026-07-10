import type { WfDataClient } from './protocol'

// Browser-side data client — talks to the host-mounted `createWfSdkHandlers`
// route over the one-POST RPC protocol. Injected into the UI via `WfSdkProvider`.

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

  async function call<T>(
    method: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<T> {
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
    const data = (await res.json()) as T
    return data
  }

  return {
    listModels: () => call('listModels', {}),
    listTools: () => call('listTools', {}),
    listTriggerEvents: () => call('listTriggerEvents', {}),
    listWorkflows: () => call('listWorkflows', {}),
    getWorkflow: (workflowId) => call('getWorkflow', { workflowId }),
    createWorkflow: (input) => call('createWorkflow', input),
    updateDraft: (input) => call('updateDraft', input),
    saveVersion: (input) => call('saveVersion', input),
    summarizeChanges: (input) => call('summarizeChanges', input),
    renameWorkflow: (input) => call('renameWorkflow', input),
    discardDraft: (input) => call('discardDraft', input),
    listVersions: (workflowId) => call('listVersions', { workflowId }),
    getVersion: (versionId) => call('getVersion', { versionId }),
    listRuns: (input) => call('listRuns', input),
    listRunTriggerKinds: () => call('listRunTriggerKinds', {}),
    getRun: (runId) => call('getRun', { runId }),
    retryRun: (input) => call('retryRun', input),
    listAgents: () => call('listAgents', {}),
    getAgent: (agentId) => call('getAgent', { agentId }),
    createAgent: (input) => call('createAgent', input),
    updateAgentDraft: (input) => call('updateAgentDraft', input),
    publishAgent: (input) => call('publishAgent', input),
    listAgentVersions: (agentId) => call('listAgentVersions', { agentId }),
    updateAgentMeta: (input) => call('updateAgentMeta', input),
    discardAgentDraft: (input) => call('discardAgentDraft', input),
    countAgentReferences: (agentId) =>
      call('countAgentReferences', { agentId }),
    // A tool-calling agent can run well past the default 20s UI backstop, so
    // give the playground its own longer budget.
    runAgentPreview: (input) => call('runAgentPreview', input, 120000),
  }
}
