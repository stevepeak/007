import type { JsonSchema } from '../engine/agent-output'
import type { ModelOption, ModelProvider } from '../engine/config'
import type { AgentConfig, AgentOutput, WorkflowGraph } from '../engine/graph'
import type { AgentNodeMeta } from '../engine/nodes/agent'
import type { TriggerEventOption } from '../engine/trigger-registry'

export type { AgentNodeMeta } from '../engine/nodes/agent'

export type { AgentConfig, AgentOutput } from '../engine/graph'
export type { JsonSchema } from '../engine/agent-output'

export type {
  TriggerEventField,
  TriggerEventOption,
} from '../engine/trigger-registry'

// The wire protocol between the SDK's React UI and the host-mounted route
// handler. Kept framework-agnostic: pure types + DTOs, no React, no Drizzle.
// The host mounts `createWfSdkHandlers` at one route; the browser talks to it
// via `createHttpWfDataClient`. Tenant identity is resolved server-side (never
// trusted from the client), so it never appears in this interface.

// Canonical model/provider shapes live in the host-injection contract; re-export
// them so the wire client and the UI import from one place.
export type {
  ModelOption,
  ModelProvider,
  ModelProviderKind,
} from '../engine/config'

export type ToolOption = {
  id: string
  /** Human-readable name shown to end users (never the raw id). */
  name: string
  /** One-line description of the service/capability. */
  description: string
  /** Optional inline SVG brand/icon markup (trusted, SDK/host-defined). */
  icon?: string
  kind: 'ai-tool' | 'function'
  /**
   * JSON Schema of the tool's input arguments (converted from the tool's Zod
   * `inputSchema`). Drives the "requires" side of node data-mapping. Absent when
   * the tool didn't declare one.
   */
  inputSchema?: JsonSchema
  /**
   * JSON Schema of the tool's output — the mappable shape a downstream node can
   * read. Absent when the tool didn't declare one.
   */
  outputSchema?: JsonSchema
}

// One recorded invocation of a tool, pulled from the run steps across all runs
// (a `wf_run_step` with `nodeKind: 'tool'` whose `meta.toolId` matches).
// Surfaces on the tool detail page's "recent calls" list.
export type WfToolInvocation = {
  /** The run this call happened in — links to the run page. */
  runId: string
  /** The tool node's id within that run's graph. */
  nodeId: string
  status: string
  /** The validated arguments the tool was called with (from the step meta). */
  args: Record<string, unknown>
  /** What the tool returned (the step output). */
  output: unknown
  error: string | null
  startedAt: number | null
  finishedAt: number | null
  /** The workflow the call happened in (for context in the list). */
  workflowId: string | null
  workflowName: string | null
}

// A host-declared **context** input for the tool playground. Tools are scoped
// by their per-run deps (built from the run context), NOT by their AI-visible
// arguments — e.g. a "client memory" tool always filters by the run's client
// org, which an agent never supplies. These fields let the playground collect
// that ambient context so a real call runs against the right scope. Each field
// is an opaque string the host maps back into the RunContext (subjectId /
// correlationId / a promptVariable) inside its `runToolPreview` handler.
export type ToolContextField = {
  /** Stable key in the context bag the playground sends back. */
  key: string
  /** Human label shown in the Context section (e.g. "Client"). */
  label: string
  /** Helper text — what it scopes, or where to find the id. */
  description?: string
  /** Placeholder/example shown in the empty input. */
  placeholder?: string
  /** Block a real run until this field has a value. */
  required?: boolean
}

// Playground: the result of running a tool for real against scratch args. This
// executes the ACTUAL tool with the host's live per-run deps — not a simulation
// — so it can hit external services, bill calls, and mutate real data.
export type WfToolPreviewResult = {
  /** The value the tool returned. */
  output: unknown
  /** The args after schema validation/defaulting — what actually ran. */
  args: Record<string, unknown>
  /** Wall-clock duration of the tool call, in milliseconds. */
  durationMs: number
}

export type WfWorkflowSummary = {
  id: string
  name: string
  description: string | null
  createdAt: number
}

export type WfWorkflowDetail = {
  workflow: WfWorkflowSummary
  draft: { graph: WorkflowGraph } | null
  currentVersion: {
    id: string
    versionNumber: number
    graph: WorkflowGraph
  } | null
}

// A git-style change summary: a one-line subject (`short`) and an optional
// longer body (`long`). Produced by the AI summarizer (or a heuristic fallback).
export type WfChangeSummary = {
  short: string
  long: string
}

export type WfVersionSummary = {
  id: string
  versionNumber: number
  /** The human's own note about the change (may be empty). */
  changeNote: string | null
  /** The AI's git-style summary — null until generated. */
  aiSummaryShort: string | null
  aiSummaryLong: string | null
  createdAt: number
  publishedAt: number | null
}

export type WfRunSummary = {
  id: string
  status: string
  triggerKind: string
  /** The workflow this run executed (resolved through its version). */
  workflowId: string
  workflowName: string
  versionNumber: number
  /** Opaque host references carried on the run (nullable). */
  subjectId: string | null
  correlationId: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  error: string | null
}

// Filters + pagination for the runs explorer. All optional; `search` matches
// workflow name / trigger kind / subject / correlation. `since`/`until` are
// epoch millis over the run's createdAt.
export type WfRunListInput = {
  workflowVersionId?: string
  workflowId?: string
  triggerKind?: string
  status?: string
  search?: string
  since?: number
  until?: number
  limit?: number
  offset?: number
}

export type WfRunListResult = {
  runs: WfRunSummary[]
  /** Total rows matching the filter (ignoring limit/offset) — drives paging. */
  total: number
  limit: number
  offset: number
}

// How the run viewer's Retry re-dispatches a finished run.
// `restart` = fresh, from the start, on the latest version; `resume` = reuse the
// original version and pick up at the failed step.
export type RetryRunMode = 'restart' | 'resume'

export type WfRunStepDTO = {
  nodeId: string
  nodeKind: string
  sequence: number
  status: string
  input: unknown
  output: unknown
  branchResult: unknown
  meta: unknown
  error: string | null
}

export type WfRunDetail = {
  run: WfRunSummary & { output: unknown }
  steps: WfRunStepDTO[]
  graph: WorkflowGraph | null
  versionNumber: number | null
}

export type WfAgentSummary = {
  id: string
  name: string
  description: string | null
  icon: string | null
  color: string | null
  createdAt: number
  /**
   * The `${variables}` the agent's latest published prompt requires, inferred
   * from its body. Drives the "requires" side of agent-node data-mapping. Empty
   * when the agent has no published version yet or its prompt has no variables.
   */
  inputVariables: string[]
  /**
   * The agent's declared output contract (from its latest published version) —
   * used to show what data an agent node produces. Null when unpublished.
   */
  output: AgentOutput | null
}

export type WfAgentVersionSummary = {
  id: string
  versionNumber: number
  changeNote: string | null
  createdAt: number
  publishedAt: number | null
}

export type WfAgentDetail = {
  agent: WfAgentSummary
  draft: { config: AgentConfig } | null
  currentVersion: {
    id: string
    versionNumber: number
    config: AgentConfig
  } | null
}

// Playground: run one agent in isolation. `config` is the editor's live draft
// (so unsaved edits are testable). An agent's inputs are its prompt `${…}`
// variables (`promptVariables`); `input` is the free-form conversational message
// for agents that take one instead. At least one is provided.
export type AgentPreviewInput = {
  config: AgentConfig
  /** Free-form message for a conversational agent (no `${…}` variables). */
  input?: string
  /** Values for the prompt's `${…}` variables, keyed by variable name. */
  promptVariables?: Record<string, string>
}

export type AgentPreviewResult = {
  output: { text: string } | Record<string, unknown>
  meta: AgentNodeMeta
  /** Progress events streamed during the run (thinking, when exposed). */
  progress: { channel: string; text: string }[]
}

// The data surface the editor + run-viewer consume. Implemented server-side by
// `createWfSdkHandlers` and over HTTP by `createHttpWfDataClient`.
export interface WfDataClient {
  listModels(): Promise<ModelOption[]>
  /**
   * The model providers the host wired up (empty when it declares none). The
   * editor shows only these and groups models under them by `providerId`.
   */
  listProviders(): Promise<ModelProvider[]>
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
  renameWorkflow(input: { workflowId: string; name: string }): Promise<void>
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
  /** Playground — run an agent draft in isolation against a scratch input. */
  runAgentPreview(input: AgentPreviewInput): Promise<AgentPreviewResult>
}

// The RPC envelope. One POST route, dispatched on `method`.
export type WfRpcRequest = { method: string; params: unknown }
