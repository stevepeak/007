import type { WfDataClient } from './protocol'

// The `WfDataClient` method map, with the transport pulled out.
//
// There are two ways to reach the data surface and only one contract, so the
// wire mapping — which method takes a positional id, which one needs a longer
// budget — lives here once and each caller supplies only the send. Over HTTP
// that's a `fetch` (`createHttpWfDataClient`); inside the Worker that already
// mounted the handlers it's a direct dispatch (`createLocalWfDataClient`).
//
// Keeping the map in one place is what lets a tool written against
// `WfDataClient` run unchanged in a browser, in `wf-mcp`, and in the System
// Copilot.

/**
 * One RPC call: a method name, its wire params, and an optional per-method
 * budget.
 *
 * `timeoutMs` is a declared property of the METHOD ("a catalog refresh upserts
 * 300+ rows"), not of any one transport, which is why it is stated in the map
 * below rather than at each call site. A transport with no notion of a timeout
 * — the in-process one — ignores it.
 */
export type WfDataTransport = (
  method: keyof WfDataClient,
  params: unknown,
  timeoutMs?: number,
) => Promise<unknown>

export function createWfDataClient(call: WfDataTransport): WfDataClient {
  // Constraining the name to `keyof WfDataClient` AND returning the protocol's
  // own return type means a typo, a rename the server outpaces, or a
  // copy-pasted wrong method (whose return shape differs) becomes a COMPILE
  // error — the one wire contract the shared type otherwise couldn't enforce.
  const send = <K extends keyof WfDataClient>(
    method: K,
    params: unknown,
    timeoutMs?: number,
  ): ReturnType<WfDataClient[K]> =>
    call(method, params, timeoutMs) as ReturnType<WfDataClient[K]>

  // Bind a zero-arg or single-object-input method to its wire call. Methods that
  // take a POSITIONAL id (wrapped into `{ key: id }` for the wire) keep an
  // explicit arrow below; their literal is still `keyof`-checked via `send`.
  const bind =
    <K extends keyof WfDataClient>(method: K, timeoutMs?: number) =>
    (params: unknown = {}): ReturnType<WfDataClient[K]> =>
      send(method, params, timeoutMs)

  return {
    listModels: bind('listModels'),
    listProviders: bind('listProviders'),
    getModelCatalog: bind('getModelCatalog'),
    getProviderBudgets: bind('getProviderBudgets'),
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
    getWorkflow: (workflowId) => send('getWorkflow', { workflowId }),
    createWorkflow: bind('createWorkflow'),
    updateDraft: bind('updateDraft'),
    saveVersion: bind('saveVersion'),
    summarizeChanges: bind('summarizeChanges'),
    updateWorkflow: bind('updateWorkflow'),
    discardDraft: bind('discardDraft'),
    listVersions: (workflowId) => send('listVersions', { workflowId }),
    getVersion: (versionId) => send('getVersion', { versionId }),
    listRuns: bind('listRuns'),
    listChildRuns: bind('listChildRuns'),
    listRunTriggerKinds: bind('listRunTriggerKinds'),
    getRun: (runId, opts) => send('getRun', { runId, ...opts }),
    getRunStatus: (runId) => send('getRunStatus', { runId }),
    retryRun: bind('retryRun'),
    setRunNote: bind('setRunNote'),
    // A full purge sweeps several tables — give it room past the 20s default.
    deleteAllRuns: bind('deleteAllRuns', 120000),
    // Six aggregates, one of which parses every agent step's meta JSON over the
    // window — slower than a typical read, so allow past the 20s default.
    getDashboard: bind('getDashboard', 60000),
    listAgents: bind('listAgents'),
    getAgent: (agentId) => send('getAgent', { agentId }),
    createAgent: bind('createAgent'),
    updateAgentDraft: bind('updateAgentDraft'),
    publishAgent: bind('publishAgent'),
    summarizeAgentChanges: bind('summarizeAgentChanges'),
    listAgentVersions: (agentId) => send('listAgentVersions', { agentId }),
    getAgentVersion: (versionId) => send('getAgentVersion', { versionId }),
    updateAgentMeta: bind('updateAgentMeta'),
    discardAgentDraft: bind('discardAgentDraft'),
    countAgentReferences: (agentId) =>
      send('countAgentReferences', { agentId }),
    listAgentReferences: (agentId) => send('listAgentReferences', { agentId }),
    archiveAgent: (agentId) => send('archiveAgent', { agentId }),
    listAgentCalls: bind('listAgentCalls'),
    // A tool-calling agent can run well past the default 20s UI backstop, so
    // give the playground its own longer budget.
    runAgentPreview: bind('runAgentPreview', 120000),

    // Evals.
    listEvalSets: bind('listEvalSets'),
    getEvalSet: (setId) => send('getEvalSet', { setId }),
    createEvalSet: bind('createEvalSet'),
    updateEvalSet: bind('updateEvalSet'),
    deleteEvalSet: (setId) => send('deleteEvalSet', { setId }),
    upsertEvalRow: bind('upsertEvalRow'),
    deleteEvalRow: (rowId) => send('deleteEvalRow', { rowId }),
    createEvalRun: bind('createEvalRun'),
    // Launching a real (simulated) run can outrun the default 20s backstop.
    startEvalRun: bind('startEvalRun', 120000),
    // Judge checks call a model — give grading its own longer budget.
    gradeEvalResult: bind('gradeEvalResult', 120000),
    // One insert, no model call. It runs on the path where something has
    // ALREADY gone wrong, so it gets the short default budget deliberately —
    // a slow failure-recorder would just compound the failure it's recording.
    recordEvalFailure: bind('recordEvalFailure'),
    finalizeEvalRun: bind('finalizeEvalRun'),
    listChanges: bind('listChanges'),
    listEvalRuns: bind('listEvalRuns'),
    getEvalRun: (evalRunId) => send('getEvalRun', { evalRunId }),

    // Feedback.
    submitFeedback: bind('submitFeedback'),
    listFeedback: bind('listFeedback'),
    setFeedbackAcknowledged: bind('setFeedbackAcknowledged'),
    setFeedbackInternalNote: bind('setFeedbackInternalNote'),
    getFeedbackForSubjects: bind('getFeedbackForSubjects'),
  }
}
