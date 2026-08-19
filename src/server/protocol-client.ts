import type {
  ModelCatalog,
  ModelOption,
  ModelProvider,
  ProviderBudget,
} from '../engine/config'
import type { AgentConfig, WorkflowGraph } from '../engine/graph'
import type { TriggerEventOption } from '../engine/trigger-registry'
import type {
  CheckTree,
  EvalFixtures,
  EvalInitialCondition,
} from '../eval/checks'

import type {
  AgentPreviewInput,
  AgentPreviewResult,
  WfAgentCall,
  WfAgentDetail,
  WfAgentSummary,
  WfAgentVersionSummary,
} from './protocol-agents'
import type { WfDashboardInput, WfDashboardResult } from './protocol-dashboard'
import type {
  WfEvalResultDTO,
  WfEvalRunDetail,
  WfEvalRunSummary,
  WfEvalSetDetail,
  WfEvalSetSummary,
  WfEvalTargetKind,
} from './protocol-evals'
import type {
  WfFeedbackListInput,
  WfFeedbackListResult,
  WfFeedbackRow,
  WfFeedbackSubmitInput,
} from './protocol-feedback'
import type {
  RetryRunMode,
  WfRunDetail,
  WfRunListInput,
  WfRunListResult,
  WfRunPurgeResult,
} from './protocol-runs'
import type {
  ToolContextField,
  ToolOption,
  WfToolInvocation,
  WfToolPreviewResult,
} from './protocol-tools'
import type {
  WfChangeSummary,
  WfVersionSummary,
  WfWorkflowDetail,
  WfWorkflowListItem,
} from './protocol-workflows'

// The data surface the editor + run-viewer consume. Implemented server-side by
// `createWfSdkHandlers` and over HTTP by `createHttpWfDataClient`.
export interface WfDataClient {
  /** The ENABLED models offered in the editor's pickers (a curated subset). */
  listModels(): Promise<ModelOption[]>
  /**
   * The model providers the host wired up (empty when it declares none). The
   * editor shows only these and groups models under them by `providerId`.
   */
  listProviders(): Promise<ModelProvider[]>
  /**
   * The full model catalog + provider status for the Models admin page (every
   * model, enabled and disabled, with pricing/metadata).
   */
  getModelCatalog(): Promise<ModelCatalog>
  /**
   * Every provider's live spend budget, one entry per provider the host
   * declares (including those that report none — see {@link ProviderBudget}).
   * Deliberately SEPARATE from `getModelCatalog`: it calls out to each
   * provider's API, so keeping it its own request lets the Models page and the
   * dashboard paint at full speed and fill the balances in when they land.
   */
  getProviderBudgets(): Promise<ProviderBudget[]>
  /**
   * Pull a provider's catalog from its `/models` endpoint and persist it,
   * preserving which models are enabled. Returns how many were cached and when.
   */
  refreshModels(input: { providerId: string }): Promise<{
    count: number
    refreshedAt: number
  }>
  /** Enable or disable a single model for the platform's pickers. */
  setModelEnabled(input: {
    modelId: string
    enabled: boolean
  }): Promise<{ ok: true }>
  listTools(): Promise<ToolOption[]>
  /** Recent times a tool was called across all runs (tool detail page). */
  listToolInvocations(input: {
    toolId: string
    limit?: number
  }): Promise<WfToolInvocation[]>
  /**
   * The host-declared context inputs the tool playground collects (e.g. which
   * client to scope to). Empty when the host wires none. See {@link ToolContextField}.
   */
  listToolContextFields(): Promise<ToolContextField[]>
  /**
   * Playground — run a tool FOR REAL against scratch args, with the host's live
   * per-run deps. This is not a simulation: the actual tool executes, so it can
   * call external services, incur cost, and mutate real data. Requires the host
   * to wire the optional `runToolPreview` handler; without it the method rejects
   * with a "not configured" error.
   */
  runToolPreview(input: {
    toolId: string
    args: Record<string, unknown>
    /** Values for the host's declared context fields, keyed by field `key`. */
    context?: Record<string, string>
  }): Promise<WfToolPreviewResult>
  /** The host's declared events + their data — offered in the creation flow. */
  listTriggerEvents(): Promise<TriggerEventOption[]>
  listWorkflows(): Promise<WfWorkflowListItem[]>
  getWorkflow(workflowId: string): Promise<WfWorkflowDetail | null>
  createWorkflow(input: {
    name: string
    description?: string
    graph: WorkflowGraph
  }): Promise<{ workflowId: string; versionId: string }>
  updateDraft(input: {
    workflowId: string
    graph: WorkflowGraph
  }): Promise<void>
  saveVersion(input: {
    workflowId: string
    graph: WorkflowGraph
    /** The human's own note about what changed. */
    changeNote?: string
    /**
     * The AI summary, if the publish dialog already had it in hand. When
     * omitted, the server generates one asynchronously after publishing.
     */
    aiSummary?: WfChangeSummary
  }): Promise<{ versionId: string; versionNumber: number }>
  /** AI-summarize the changes since the latest published version (publish dialog). */
  summarizeChanges(input: {
    workflowId: string
    graph: WorkflowGraph
  }): Promise<WfChangeSummary>
  updateWorkflow(input: {
    workflowId: string
    name?: string
    description?: string | null
    archived?: boolean
  }): Promise<void>
  discardDraft(input: { workflowId: string }): Promise<void>
  listVersions(workflowId: string): Promise<WfVersionSummary[]>
  getVersion(
    versionId: string,
  ): Promise<{ graph: WorkflowGraph; versionNumber: number } | null>
  listRuns(input: WfRunListInput): Promise<WfRunListResult>
  /** Distinct trigger kinds seen across all runs (filter dropdown). */
  listRunTriggerKinds(): Promise<string[]>
  /**
   * The full run-inspector load. `knownVersionId` is a cache hint for pollers:
   * pass the `workflowVersionId` you already hold the version block for and the
   * server skips reading it, answering with `versionOmitted: true` and null
   * placeholders. The block is immutable per version id, so this trades a query
   * and the entire serialized graph for one string on the wire. Omit it — as
   * every one-shot caller does — for a complete response.
   */
  getRun(runId: string, knownVersionId?: string): Promise<WfRunDetail | null>
  /**
   * Re-dispatch a finished run as a NEW run (the original stays as history).
   * The same trigger input is reconstructed from the original run's recorded
   * trigger step. Modes:
   * - `restart` — start fresh from the beginning on the workflow's LATEST
   *   version (pick up graph fixes published since the failed run).
   * - `resume` — reuse the run's ORIGINAL version and replay its completed
   *   steps, re-executing only from the node that failed. Best for transient
   *   failures (a network blip) where re-running the whole graph is wasteful.
   *
   * Requires the host to wire the optional `retryRun` handler hook — without it
   * the method rejects with a "not configured" error.
   */
  retryRun(input: {
    runId: string
    mode: RetryRunMode
  }): Promise<{ runId: string }>
  /**
   * Delete EVERY run and everything derived from it — steps, the log feed, and
   * the eval results/runs that grade those runs. Feedback rows survive with
   * their `runId` cleared. Definitions (workflows, agents, eval sets) are
   * untouched. Irreversible; the UI gates it behind a modifier-hold + a
   * press-and-hold confirm.
   */
  deleteAllRuns(): Promise<WfRunPurgeResult>
  /**
   * The home dashboard's rollup — run volume per workflow, spend per model, the
   * outstanding feedback queue, and the newest failures — in one round trip.
   * Everything is derived per request; nothing is precomputed. The server clamps
   * the requested window and returns the one it actually charted.
   */
  getDashboard(input: WfDashboardInput): Promise<WfDashboardResult>

  // Agents — reusable, pre-developed agents that workflow agent nodes point at.
  // Same draft/version lifecycle as workflows; publishing floats into every
  // referencing workflow.
  listAgents(): Promise<WfAgentSummary[]>
  getAgent(agentId: string): Promise<WfAgentDetail | null>
  createAgent(input: {
    name: string
    description?: string
    icon?: string
    color?: string
    config: AgentConfig
  }): Promise<{ agentId: string; versionId: string }>
  updateAgentDraft(input: {
    agentId: string
    config: AgentConfig
  }): Promise<void>
  publishAgent(input: {
    agentId: string
    config: AgentConfig
    changeNote?: string
    /** Ridden along when the publish dialog's summary landed in time. */
    aiSummary?: WfChangeSummary
  }): Promise<{ versionId: string; versionNumber: number }>
  /** AI-summarize the changes since the latest published version (publish dialog). */
  summarizeAgentChanges(input: {
    agentId: string
    config: AgentConfig
  }): Promise<WfChangeSummary>
  listAgentVersions(agentId: string): Promise<WfAgentVersionSummary[]>
  getAgentVersion(
    versionId: string,
  ): Promise<{ config: AgentConfig; versionNumber: number } | null>
  updateAgentMeta(input: {
    agentId: string
    name?: string
    description?: string
    icon?: string
    color?: string
  }): Promise<void>
  discardAgentDraft(input: { agentId: string }): Promise<void>
  /** For the publish-warning dialog — how many workflows reference this agent. */
  countAgentReferences(agentId: string): Promise<{ workflows: number }>
  /**
   * The workflows that reference this agent in their draft or latest published
   * version — powers the archive dialog's "disconnect these first" block.
   */
  listAgentReferences(
    agentId: string,
  ): Promise<{ workflows: { id: string; name: string }[] }>
  /**
   * Soft-delete the agent (drops it from the agents list + node picker). Rejects
   * if any workflow still references it — the UI blocks first, this is a backstop.
   */
  archiveAgent(agentId: string): Promise<void>
  /**
   * This agent's most recent executions across all runs, newest first, each
   * reduced to its metrics (turns, tokens, cost, per-tool call counts). Powers
   * the agent editor's "Recent calls" section. Real runs only — an eval's
   * simulated runs never appear.
   */
  listAgentCalls(input: {
    agentId: string
    limit?: number
  }): Promise<WfAgentCall[]>
  /** Playground — run an agent draft in isolation against a scratch input. */
  runAgentPreview(input: AgentPreviewInput): Promise<AgentPreviewResult>

  // Evals — sets (Goals) of rows (Samples) run against a target and graded by a
  // check tree. Data methods operate on the global set (host-gatekept at the
  // route); `startEvalRun` is a host-wired hook, `gradeEvalResult` grades a
  // finished run's trace inside the SDK.
  listEvalSets(input?: {
    includeArchived?: boolean
  }): Promise<WfEvalSetSummary[]>
  getEvalSet(setId: string): Promise<WfEvalSetDetail | null>
  createEvalSet(input: {
    name: string
    description?: string
    targetKind: WfEvalTargetKind
    targetId: string
    /** Version pin for the target: null/omitted floats to latest. */
    targetVersion?: number | null
    triggerKind: string
  }): Promise<{ setId: string }>
  updateEvalSet(input: {
    setId: string
    name?: string
    description?: string | null
    targetKind?: WfEvalTargetKind
    targetId?: string
    targetVersion?: number | null
    triggerKind?: string
    archived?: boolean
  }): Promise<{ ok: true }>
  /** Hard-delete a set and its rows (runs/results are kept as history). */
  deleteEvalSet(setId: string): Promise<{ ok: true }>
  /** Create (no `id`) or update (with `id`) a row; validates the JSON payloads. */
  upsertEvalRow(input: {
    id?: string
    setId: string
    name: string
    description?: string | null
    initialCondition?: EvalInitialCondition
    fixtures?: EvalFixtures
    checks?: CheckTree
    sortOrder?: number
  }): Promise<{ rowId: string }>
  /** Soft-delete a row (drops out of the set + its row count). */
  deleteEvalRow(rowId: string): Promise<{ ok: true }>

  /** Create the umbrella eval run over one or more sets (status `queued`). */
  createEvalRun(input: {
    setIds: string[]
    total?: number
  }): Promise<{ evalRunId: string }>
  /**
   * Start ONE row's run for real — a `simulate: true, isEval: true` graph run
   * against the set's target, stubbing read tools with the row's fixtures. This
   * is a host-wired hook (mirrors `retryRun`): the SDK resolves the row + target
   * and hands the host a descriptor; the host owns the workflow-instance start
   * (it has the runtime bindings) and returns the new `wf_run` id. Without the
   * hook wired the method rejects with a "not configured" error.
   */
  startEvalRun(input: {
    evalRunId: string
    rowId: string
    /** Matrix cell: override the target agent's model (composite catalog id). */
    modelId?: string
    /** Matrix cell: replace the target agent's system prompt (baseline omits it). */
    promptBody?: string
  }): Promise<{ wfRunId: string }>
  /**
   * Grade a finished row run: load the `wf_run` trace, evaluate the row's check
   * tree (judge checks use the host's model seam), and persist the verdict as a
   * result. Pure SDK — no host hook.
   */
  gradeEvalResult(input: {
    evalRunId: string
    rowId: string
    wfRunId: string
    /** Matrix cell identity to stamp on the result (all optional for a plain run). */
    modelId?: string
    promptLabel?: string
    promptBody?: string
    attempt?: number
  }): Promise<WfEvalResultDTO>
  /**
   * Record a cell that never produced a gradeable run — the run failed, was
   * cancelled, or was still executing when the orchestrator stopped waiting.
   *
   * Separate from `gradeEvalResult` on purpose: that method requires a finished
   * `wf_run` and calls the judge model, whereas this one must be cheap and must
   * work even when `startEvalRun` itself threw and there is no run id at all.
   * Every cell writing SOME row is what keeps the run's `total` honest — a cell
   * with no row silently doesn't count, which is how a provider outage rendered
   * as "0 results" with no explanation.
   */
  recordEvalFailure(input: {
    evalRunId: string
    rowId: string
    /** The run that was started, when one was. */
    wfRunId?: string
    /** Human-readable reason, shown verbatim in the report. */
    error: string
    /** Matrix cell identity to stamp on the result (all optional for a plain run). */
    modelId?: string
    promptLabel?: string
    promptBody?: string
    attempt?: number
  }): Promise<WfEvalResultDTO>
  /** Roll up an eval run's results into its final counts/score + status. */
  finalizeEvalRun(input: { evalRunId: string }): Promise<WfEvalRunSummary>
  listEvalRuns(input?: { limit?: number }): Promise<WfEvalRunSummary[]>
  getEvalRun(evalRunId: string): Promise<WfEvalRunDetail | null>

  // Feedback — thumbs up/down + optional note a human leaves on an answer, plus
  // the staff-side triage view. Data is a single global set keyed by opaque host
  // ids (like runs); the host gatekeeps the route. The rater is stamped from the
  // authenticated context server-side, never trusted off the input.
  /** Submit / change / clear (`rating: null`) a subject's thumb. */
  submitFeedback(input: WfFeedbackSubmitInput): Promise<{ ok: true }>
  /** The triage list — filtered rated subjects + facet dropdowns. */
  listFeedback(input: WfFeedbackListInput): Promise<WfFeedbackListResult>
  /** Toggle a subject's triage acknowledgement (staff acted on it). */
  setFeedbackAcknowledged(input: {
    subjectId: string
    acknowledged: boolean
  }): Promise<{ ok: true }>
  /**
   * Set (or clear, with `null`) the staff-only internal note — a resolution log
   * kept alongside the customer's `note`, e.g. how the feedback was fixed.
   */
  setFeedbackInternalNote(input: {
    subjectId: string
    note: string | null
  }): Promise<{ ok: true }>
  /** Re-hydrate current rating/note for a set of subjects (host read path). */
  getFeedbackForSubjects(input: {
    subjectIds: string[]
  }): Promise<WfFeedbackRow[]>
}

// The RPC envelope. One POST route, dispatched on `method`.
export type WfRpcRequest = { method: string; params: unknown }
