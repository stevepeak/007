import type { AgentConfig, AgentOutput } from '../engine/graph'
import type { AgentNodeMeta } from '../engine/nodes/agent'

export type { AgentNodeMeta } from '../engine/nodes/agent'

export type { AgentConfig, AgentOutput } from '../engine/graph'

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
  /**
   * The model id the agent's latest published (or, in {@link WfAgentDetail},
   * current) config resolves through `getModel`. Null when unpublished or the
   * config is malformed. Pair with {@link WfDataClient.listModels} for a label.
   */
  modelId: string | null
  /**
   * The tool ids the agent's config enables. Empty when it uses none, is
   * unpublished, or the config is malformed. Resolve to names/icons via
   * {@link WfDataClient.listTools}.
   */
  toolIds: string[]
  /**
   * The workflows whose draft or latest published version reference this agent
   * (via an agent node). Populated by {@link WfDataClient.listAgents}; empty in
   * the single-agent {@link WfDataClient.getAgent} summary.
   */
  workflows: { id: string; name: string }[]
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
