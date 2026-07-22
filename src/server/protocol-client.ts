import type { AgentConfig, WorkflowGraph } from '../engine/graph'
import type { ModelCatalog, ModelOption, ModelProvider } from '../engine/config'
import type { TriggerEventOption } from '../engine/trigger-registry'
import type {
  CheckTree,
  EvalFixtures,
  EvalInitialCondition,
} from '../eval/checks'
import type {
  AgentPreviewInput,
  AgentPreviewResult,
  WfAgentDetail,
  WfAgentSummary,
  WfAgentVersionSummary,
} from './protocol-agents'
import type {
  WfEvalResultDTO,
  WfEvalRunDetail,
  WfEvalRunSummary,
  WfEvalSetDetail,
  WfEvalSetSummary,
  WfEvalTargetKind,
} from './protocol-evals'
import type {
  RetryRunMode,
  WfRunDetail,
  WfRunListInput,
  WfRunListResult,
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
  WfWorkflowSummary,
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
  listWorkflows(): Promise<WfWorkflowSummary[]>
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
  getRun(runId: string): Promise<WfRunDetail | null>
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
  }): Promise<{ versionId: string; versionNumber: number }>
  listAgentVersions(agentId: string): Promise<WfAgentVersionSummary[]>
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
  /** Roll up an eval run's results into its final counts/score + status. */
  finalizeEvalRun(input: { evalRunId: string }): Promise<WfEvalRunSummary>
  listEvalRuns(input?: { limit?: number }): Promise<WfEvalRunSummary[]>
  getEvalRun(evalRunId: string): Promise<WfEvalRunDetail | null>
}

// The RPC envelope. One POST route, dispatched on `method`.
export type WfRpcRequest = { method: string; params: unknown }
