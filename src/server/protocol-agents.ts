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
   * Where the agent's messages come from (`AgentConfig.inputKind`).
   * `'conversation'` → a node pointing at it MUST bind the `conversation` input.
   * `'task'` → it runs on its own rendered user message alone. Defaults to
   * `'task'` when the agent is unpublished or its config is malformed.
   */
  inputKind: 'conversation' | 'task'
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

// Structurally identical to `WfVersionSummary` — deliberately, so one
// `VersionsMenu` renders the history of either entity.
export type WfAgentVersionSummary = {
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
   * Prior turns for an agent whose `inputKind` is `'conversation'` — the history
   * that precedes `input`, in order. Stands in for what a chat trigger's
   * `messages` would supply in a real run; `input` is appended as the current
   * user turn. Omitted/empty → the agent answers with no prior context. Ignored
   * for a task agent, whose only turn is its own `userPrompt`.
   */
  messages?: AgentPreviewMessage[]
  /**
   * The ambient run scope for the tools running live, keyed by
   * {@link ToolContextField} `key` (e.g. `clientOrgId`). The host maps these into
   * the RunContext its `buildRunDeps` reads. Only the keys the live tools
   * declare via `requiresContext` are collected; a simulated run sends none.
   */
  context?: Record<string, string>
}

/**
 * One agent's executions inside ONE run node, folded into a single row — what
 * the agent editor's "Recent calls" tab lists. The unit is the CALL SITE, not
 * the individual execution: an agent inside an iteration runs once per item, so
 * `callCount` says how many times it ran there and the metrics are the totals
 * across them. No input/output on purpose: the tab answers "how hard did it
 * work, and what did it cost"; the run holds the data, one click away.
 */
export type WfAgentCall = {
  /** The run these calls happened in — links to the run page. */
  runId: string
  /** The graph node that ran them, or a `sub:<primary>:<n>` id for a sub-agent. */
  nodeId: string
  /** How many executions this row folds — >1 only for an iteration fan-out. */
  callCount: number
  /** The 0-based iteration item indexes covered, ascending; empty outside a
   *  fan-out. Lets the caller address each individual call's recorded step. */
  itemIndexes: number[]
  /** The group's worst status — one failed item makes the whole row failed. */
  status: string
  /** The first error across the group, when any call failed. */
  error: string | null
  /** How many of the `callCount` executions failed. */
  failedCount: number
  /** Earliest start, falling back to the run's creation time for a queued call. */
  startedAt: number | null
  /** Latest finish; null while any call is still running. */
  finishedAt: number | null
  /** Summed wall-clock ACROSS the calls; null when no timing was recorded. */
  durationMs: number | null
  workflowId: string | null
  workflowName: string | null
  versionNumber: number | null
  /** Provider-native model id the calls ran on. */
  model: string | null
  /** The agent version resolved from the run manifest, when stamped. */
  agentVersion: number | null
  /** Rounds of the tool loop, summed across the calls. */
  turns: number
  inputTokens: number
  outputTokens: number
  /** Derived USD cost; null when no call ran on a priced model. */
  costUsd: number | null
  /** Per-tool call counts across every call and turn, most-called first. Ids
   *  resolve to names/icons via {@link WfDataClient.listTools}; a `spawn_*` /
   *  `await_subagents` id is a synthesized delegation tool, not a registered one. */
  toolCalls: { toolId: string; count: number }[]
  /** Any call stopped researching early — its token budget, or the model's
   *  context window, ended the loop before `maxTurns` did. */
  stoppedOnTokenBudget: boolean
  stoppedOnContextLimit: boolean
  /** Set when these calls were a SPAWNED sub-agent rather than a graph node. */
  subAgentName: string | null
}

export type AgentPreviewResult = {
  output: { text: string } | Record<string, unknown>
  meta: AgentNodeMeta
  /** Progress events streamed during the run (thinking, when exposed). */
  progress: { channel: string; text: string }[]
}
