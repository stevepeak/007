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
   * Whether the agent declares that it works on a chat thread
   * (`AgentConfig.acceptsConversation`). True → an agent node pointing at it
   * exposes the optional `conversation` input. False when it takes a single
   * input value, is unpublished, or the config is malformed.
   */
  acceptsConversation: boolean
  /**
   * The agent's newest version number, or null when it has never been
   * published. This is what a float-to-latest reference (an agent node with no
   * version pin) currently resolves to, so the editor can show the version an
   * agent node WOULD run without an extra per-agent fetch.
   */
  latestVersionNumber: number | null
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

/**
 * One authored turn in the playground's scratch conversation. Only what a chat
 * thread carries before the agent runs — a role and its text; tool calls belong
 * to the run, not to the history you hand it.
 */
export type AgentPreviewMessage = {
  role: 'user' | 'assistant'
  text: string
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
  /**
   * Tool ids to execute FOR REAL in this run instead of simulating them. Every
   * other tool is stood in for by the model. Omitted → the whole run is
   * simulated (the safe default): no live call is made and no real data moves.
   */
  liveToolIds?: string[]
  /**
   * Prior turns for an agent that works on a conversation
   * (`AgentConfig.acceptsConversation`) — the history that precedes `input`, in
   * order. Stands in for what a chat trigger's `messages` would supply in a real
   * run; `input` (or the rendered `promptVariables`) is appended as the current
   * user turn. Omitted/empty → the agent answers with no prior context.
   */
  messages?: AgentPreviewMessage[]
}

/**
 * One recorded execution of an agent, reduced to its metrics — what the agent
 * editor's "Recent calls" section shows. No input/output on purpose: the section
 * answers "how hard did it work, and what did it cost"; the run page holds the
 * data itself, one click away via `runId`.
 */
export type WfAgentCall = {
  /** The run this call happened in — links to the run page. */
  runId: string
  /** The graph node that ran it, or a `sub:<primary>:<n>` id for a sub-agent. */
  nodeId: string
  /** 0-based item index when the call ran inside an iteration; null otherwise. */
  itemIndex: number | null
  status: string
  error: string | null
  /** Step start, falling back to the run's creation time for a queued call. */
  startedAt: number | null
  finishedAt: number | null
  /** The agent call's own wall-clock in ms; null when no timing was recorded. */
  durationMs: number | null
  workflowId: string | null
  workflowName: string | null
  versionNumber: number | null
  /** Provider-native model id the call ran on. */
  model: string | null
  /** The agent version resolved from the run manifest, when stamped. */
  agentVersion: number | null
  /** Rounds of the tool loop the agent took. */
  turns: number
  inputTokens: number
  outputTokens: number
  /** Derived USD cost; null when the model carries no catalog price. */
  costUsd: number | null
  /** Per-tool call counts across every turn, most-called first. Ids resolve to
   *  names/icons via {@link WfDataClient.listTools}; a `spawn_*` /
   *  `await_subagents` id is a synthesized delegation tool, not a registered one. */
  toolCalls: { toolId: string; count: number }[]
  /** The agent stopped researching early — its token budget, or the model's
   *  context window, ended the loop before `maxTurns` did. */
  stoppedOnTokenBudget: boolean
  stoppedOnContextLimit: boolean
  /** Set when this call was a SPAWNED sub-agent rather than a graph node. */
  subAgentName: string | null
}

export type AgentPreviewResult = {
  output: { text: string } | Record<string, unknown>
  meta: AgentNodeMeta
  /** Progress events streamed during the run (thinking, when exposed). */
  progress: { channel: string; text: string }[]
}
