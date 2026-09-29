import type { LanguageModel, ToolSet, UIMessage } from 'ai'

import type { AgentOutput } from '../graph'
import type { ModelBudget } from '../model-budget'
import type { StreamSink } from '../stream-sink'

// What a generation is ASKED for and what it hands BACK — the contract between
// `runAgentGeneration` and its two callers (the agent node, and a spawned
// sub-agent), plus the shape of the meta a run step records.
//
// In its own module because all four generation modules name these types and
// none of them should have to import another to do it. The behaviour lives in
// `agent-generation.ts` (the loop), `-structured.ts` (the object paths),
// `-turn.ts` (per-step policy and tracing) and `-guard.ts` (budget + fatality).


/**
 * The agent version a recorded step ran, or null when unstamped.
 *
 * Lives here, beside the type it reads, because two layers need it and neither
 * may import the other: the run viewer names the version a run executed, and the
 * eval report needs it to catch the case its snapshot hash structurally cannot —
 * a Goal with no pinned `targetVersion` floats to latest, so republishing the
 * agent leaves the hash IDENTICAL. Same hash, different agent, different score.
 *
 * Takes `unknown` because every caller reads it off a stored `meta` column.
 */
export function stepAgentVersion(meta: unknown): number | null {
  const v = (meta as { agentVersion?: unknown } | null | undefined)
    ?.agentVersion
  return typeof v === 'number' ? v : null
}

export type AgentNodeMeta = {
  model: string
  systemPrompt: string
  /**
   * The messages the model was actually sent, as plain role/text — the rendered
   * user turn for a task agent, the bound thread for a conversation one.
   *
   * Recorded because the run viewer used to render the step's INPUT as the user
   * message, which was true only while an incoming edge implicitly became the
   * turn. It no longer does, and a viewer that keeps showing the edge payload as
   * "the message" reports something the model never saw. Text-only: image parts
   * and tool payloads would balloon every stored step.
   */
  messages?: Array<{ role: string; text: string }>
  /**
   * Which AGENT this generation ran — stamped by the caller (the agent node or a
   * spawned sub-agent), not by generation itself, which only knows a prompt and
   * a model. It's the only durable link from a recorded step back to the agent:
   * a graph node id resolves to an agent only through its version's graph, and a
   * sub-agent step has no graph node at all. The agent editor's "recent calls"
   * queries on it. Absent on steps recorded before the stamp existed.
   */
  agentId?: string
  /** The published version of that agent, from the frozen run manifest. */
  agentVersion?: number
  steps: Array<{
    stepNumber: number
    finishReason?: string
    /** The model's internal reasoning for this step, if it emitted any. */
    reasoning?: string
    /** The assistant's generated output text for this step. */
    text?: string
    toolCalls: Array<{
      toolCallId: string
      toolName: string
      input: unknown
      output: unknown
    }>
    usage?: { inputTokens?: number; outputTokens?: number }
  }>
  totalUsage: { inputTokens: number; outputTokens: number }
  /**
   * The model's context window as the run manifest froze it, so a viewer can
   * read each turn's `usage.inputTokens` as a share of the window — the
   * occupancy the context guard above steers by. Absent when the provider
   * reported no window, and on steps recorded before it was stamped.
   */
  contextLength?: number
  /**
   * Set when the agent's `toolTokenBudget` — not `maxTurns` — is what ended its
   * research. The answer is still a real answer, but it was written against
   * whatever the agent had gathered by then, so a reader comparing two runs of
   * the same agent needs to know one of them was cut short.
   */
  stoppedOnTokenBudget?: boolean
  /**
   * Set when the conversation approached the model's context window and the loop
   * stopped gathering to avoid overflowing it. Unlike the budget this isn't a
   * choice anyone made, so seeing it means the agent's tools return more than
   * this model can hold — the fix is smaller tool results or a bigger model, not
   * a config change.
   */
  stoppedOnContextLimit?: boolean
}

export type AgentNodeResult = {
  output: { text: string } | Record<string, unknown>
  meta: AgentNodeMeta
  /**
   * Set only for a YES/NO (boolean) output agent — 'yes' when `answer` is true,
   * 'no' otherwise. Lets the agent node route its outgoing yes/no edges like a
   * Branch; `decisionReasoning` carries the model's `reason` for the trace.
   */
  decision?: 'yes' | 'no'
  decisionReasoning?: string
}

export type RunAgentGenerationArgs = {
  model: LanguageModel
  /** The model id, reflected into `meta.model` so cost prices correctly. */
  modelId: string
  /** The agent's expected-output contract — selects the generation path. */
  output: AgentOutput
  /** Max rounds of tool-calling before a final answer. */
  maxTurns: number
  /**
   * Force turn 1 to call a tool rather than letting the model answer straight
   * away. Inert where it can't hold — no tools, or `maxTurns: 1`. See
   * `requireToolFirstTurn` on `AgentConfig`.
   */
  requireToolFirstTurn?: boolean
  /**
   * Spend ceiling for the tool loop, in tokens summed across finished turns.
   * Reaching it denies tools on the next turn, forcing the answer. Omitted or
   * null → no ceiling. See `toolTokenBudget` on `AgentConfig`.
   */
  toolTokenBudget?: number | null
  /**
   * The model's context window, frozen into the run manifest. Used only by the
   * overflow guard below. Omitted → the guard stands down (no window reported).
   */
  contextLength?: number
  /**
   * Percentage of `contextLength` to keep free for writing the answer. Defaults
   * to 10 when unset. Ignored without a `contextLength` to take a share of.
   */
  answerReservePercent?: number
  /** Stream the model's reasoning to the user's 'progress' channel when true. */
  streamReasoning: boolean
  /** Announce each tool the model calls on the user's 'progress' channel when
   * true. Display only — it never affects which tools the agent may call. */
  streamToolCalls: boolean
  systemPrompt: string
  messages: UIMessage[]
  tools: ToolSet
  /**
   * Per-tool human-readable status templates, keyed by tool id (== the tool name
   * the model calls). When `streamToolCalls` is on, a matching template is
   * interpolated with the call's input and streamed to the user; tools without a
   * template expose nothing.
   */
  toolStatusLabels?: Record<string, string>
  sink?: StreamSink
  /**
   * Time budget for this generation (see `../model-budget`). Omitted →
   * unbounded, which is only appropriate where something else bounds the call
   * (tests, the inline executor).
   */
  budget?: ModelBudget
}

// Flatten the sent messages to role/text for the recorded trace. Non-text parts
// (files, tool payloads) are deliberately dropped — the trace is for reading
// what the model was asked, not for reconstructing the request byte for byte.
export function recordedMessages(
  messages: UIMessage[],
): { role: string; text: string }[] {
  return messages.map((m) => ({
    role: m.role,
    text: m.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n'),
  }))
}
