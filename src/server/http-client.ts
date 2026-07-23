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
    method: keyof WfDataClient,
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

  // Bind a zero-arg or single-object-input method to its wire call. Constraining
  // the name to `keyof WfDataClient` AND returning the protocol's own return type
  // means a typo, a rename the server outpaces, or a copy-pasted wrong method
  // (whose return shape differs) becomes a COMPILE error — the one wire contract
  // the shared type otherwise couldn't enforce. Methods that take a POSITIONAL id
  // (wrapped into `{ key: id }` for the wire) keep an explicit arrow below; their
  // literal is still `keyof`-checked via `call`.
  const bind =
    <K extends keyof WfDataClient>(method: K, timeoutMs?: number) =>
    (params: unknown = {}): ReturnType<WfDataClient[K]> =>
      call(method, params, timeoutMs) as ReturnType<WfDataClient[K]>

  return {
    listModels: bind('listModels'),
    listProviders: bind('listProviders'),
    getModelCatalog: bind('getModelCatalog'),
    // Fetching a provider's full catalog hits an external `/models` endpoint and
    // upserts 300+ rows — give it a longer budget than the 20s UI backstop.
    refreshModels: bind('refreshModels', 120000),
    setModelEnabled: bind('setModelEnabled'),
    listTools: bind('listTools'),
    listToolInvocations: bind('listToolInvocations'),
    listToolContextFields: bind('listToolContextFields'),
    // A real tool call can run past the default 20s UI backstop (external
    // services), so give the playground its own longer budget.
    runToolPreview: bind('runToolPreview', 120000),
    listTriggerEvents: bind('listTriggerEvents'),
    listWorkflows: bind('listWorkflows'),
    getWorkflow: (workflowId) => call('getWorkflow', { workflowId }),
    createWorkflow: bind('createWorkflow'),
    updateDraft: bind('updateDraft'),
    saveVersion: bind('saveVersion'),
    summarizeChanges: bind('summarizeChanges'),
    updateWorkflow: bind('updateWorkflow'),
    discardDraft: bind('discardDraft'),
    listVersions: (workflowId) => call('listVersions', { workflowId }),
    getVersion: (versionId) => call('getVersion', { versionId }),
    listRuns: bind('listRuns'),
    listRunTriggerKinds: bind('listRunTriggerKinds'),
    getRun: (runId) => call('getRun', { runId }),
    retryRun: bind('retryRun'),
    listAgents: bind('listAgents'),
    getAgent: (agentId) => call('getAgent', { agentId }),
    createAgent: bind('createAgent'),
    updateAgentDraft: bind('updateAgentDraft'),
    publishAgent: bind('publishAgent'),
    listAgentVersions: (agentId) => call('listAgentVersions', { agentId }),
    updateAgentMeta: bind('updateAgentMeta'),
    discardAgentDraft: bind('discardAgentDraft'),
    countAgentReferences: (agentId) =>
      call('countAgentReferences', { agentId }),
    listAgentReferences: (agentId) =>
      call('listAgentReferences', { agentId }),
    archiveAgent: (agentId) => call('archiveAgent', { agentId }),
    // A tool-calling agent can run well past the default 20s UI backstop, so
    // give the playground its own longer budget.
    runAgentPreview: bind('runAgentPreview', 120000),

    // Evals.
    listEvalSets: bind('listEvalSets'),
    getEvalSet: (setId) => call('getEvalSet', { setId }),
    createEvalSet: bind('createEvalSet'),
    updateEvalSet: bind('updateEvalSet'),
    deleteEvalSet: (setId) => call('deleteEvalSet', { setId }),
    upsertEvalRow: bind('upsertEvalRow'),
    deleteEvalRow: (rowId) => call('deleteEvalRow', { rowId }),
    createEvalRun: bind('createEvalRun'),
    // Launching a real (simulated) run can outrun the default 20s backstop.
    startEvalRun: bind('startEvalRun', 120000),
    // Judge checks call a model — give grading its own longer budget.
    gradeEvalResult: bind('gradeEvalResult', 120000),
    finalizeEvalRun: bind('finalizeEvalRun'),
    listEvalRuns: bind('listEvalRuns'),
    getEvalRun: (evalRunId) => call('getEvalRun', { evalRunId }),

    // Feedback.
    submitFeedback: bind('submitFeedback'),
    listFeedback: bind('listFeedback'),
    setFeedbackAcknowledged: bind('setFeedbackAcknowledged'),
    setFeedbackInternalNote: bind('setFeedbackInternalNote'),
    getFeedbackForSubjects: bind('getFeedbackForSubjects'),
  }
}
