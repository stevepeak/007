import type { LanguageModel, StepResult, ToolSet } from 'ai'

import { interpolateUserText } from '../prompt-variables'
import type { StreamSink } from '../stream-sink'

import type { AgentNodeMeta } from './agent-generation-types'

// What happens per TURN of the tool loop, on both sides of the model call.
//
// The AI SDK owns the loop itself — `generateText`/`streamText` keep calling the
// model until `stopWhen` fires — and hands us exactly two seams: `prepareStep`
// runs before each turn and decides what that turn is allowed to do, and
// `onStepFinish` runs after it and is the only place a turn's usage, reasoning
// and tool calls exist. Those two are where every loop policy lives, and they
// talk to each other through the mutable {@link AgentLoopState} below: the
// context guard reads occupancy the tracer measured, and the answer-streaming
// decision reads a flag the policy set.
//
// They are here rather than inline in `runToolLoop` because they are the loop's
// actual behaviour, and because a policy with four rules in strict precedence is
// worth reading — and testing — without a 400-line body around it.

/**
 * Everything the two seams share, mutated in place across the loop's turns.
 *
 * Mutable on purpose: `prepareStep` and `onStepFinish` are callbacks the SDK
 * invokes, so there is no return value to thread state through, and the loop's
 * final result reads the accumulated totals off the same object.
 */
export type AgentLoopState = {
  /** One entry per turn, in order — becomes `meta.steps`. */
  stepTraces: AgentNodeMeta['steps']
  /** Summed across finished turns. Read by the spend ceiling. */
  totalUsage: { inputTokens: number; outputTokens: number }
  /**
   * `inputTokens` of the most recent round-trip — i.e. the conversation as SENT,
   * which is the occupancy the context guard steers by. Zero until a turn lands.
   */
  lastInputTokens: number
  /**
   * The largest turn-over-turn jump in `lastInputTokens` seen so far.
   * Deliberately the max, not the last: a single fat tool result is exactly the
   * thing that overflows the next request, so the guard has to survive the worst
   * result this agent actually produces rather than the average one.
   */
  observedGrowth: number
  /** Set when the spend ceiling — not `maxTurns` — is what ended the research. */
  stoppedOnTokenBudget: boolean
  /** Set when the context guard stopped the research to protect the window. */
  stoppedOnContextLimit: boolean
  /**
   * Whether the turn now being generated was DENIED tools, and so must answer.
   * Re-decided by `prepareStep` on every turn; read by the delta forwarder (only
   * a step we know must answer may stream) and by `parseObject` (only a turn that
   * was sent the schema counts as the object).
   */
  stepMustAnswer: boolean
}

export function createLoopState(): AgentLoopState {
  return {
    stepTraces: [],
    totalUsage: { inputTokens: 0, outputTokens: 0 },
    lastInputTokens: 0,
    observedGrowth: 0,
    stoppedOnTokenBudget: false,
    stoppedOnContextLimit: false,
    stepMustAnswer: false,
  }
}

/**
 * What `prepareStep` may hand back. Spelled out because `callOptions` in the loop
 * is a bare literal with no contextual type (it feeds both `generateText` and
 * `streamText`), so the SDK's own parameter types don't flow in.
 */
export type PreparedStep = {
  toolChoice?: 'none' | 'required'
  model?: LanguageModel
}

export type TurnPolicyArgs = {
  state: AgentLoopState
  modelId: string
  maxTurns: number
  /** The model with the schema forced on, for a turn that has to answer. */
  answeringModel: LanguageModel
  /** Whether the agent has any tool at all to call. */
  hasTools: boolean
  /** The model's context window, frozen into the run manifest. Absent → the
   * overflow guard stands down, since no window was reported. */
  contextLength?: number
  /** Percentage of `contextLength` to keep free for writing the answer.
   * Defaults to 10. Ignored without a `contextLength` to take a share of. */
  answerReservePercent?: number
  /** Spend ceiling in tokens summed across finished turns. Null → none. */
  toolTokenBudget?: number | null
  /** Deny turn 1 the option of answering from what the model already "knows".
   * Inert where it can't hold — see `forceFirstTool` below. */
  requireToolFirstTurn?: boolean
  sink?: StreamSink
}

/**
 * The per-turn policy: what this turn is allowed to do.
 *
 * FOUR RULES, IN STRICT PRECEDENCE. The three that DENY tools come first and are
 * never overridden — whatever else is configured, an agent that is out of turns,
 * out of window, or out of budget has to write its answer now.
 *
 *  1. Out of turns. The last turn is for answering, not for opening another line
 *     of research the loop has no room to follow up on. Without this, a model
 *     that spends every turn calling tools stops mid-investigation and
 *     `result.text` is the empty string — a completed run with nothing in it,
 *     which is how a $0.64 chat turn rendered as a blank message.
 *
 *  2. Out of window. Checked BEFORE the spend budget, because overflowing the
 *     context is a hard error and the budget is a preference. `inputTokens` of a
 *     round-trip IS the conversation as sent, so occupancy needs no estimation —
 *     but it can only be read AFTER sending, which makes every reading one turn
 *     stale. A naive "stop at N% full" therefore has to leave slack for one more
 *     turn's growth on top of the answer, and the author has no way to know how
 *     much that is: it's the size of their tool results, which they've never
 *     measured. So the engine measures it (`observedGrowth`) and stops once
 *     `lastInput + growth` would leave less than the answer reserve. An agent
 *     with small tool results rides much closer to the window than a fixed
 *     percentage would have allowed; one with huge results stops sooner.
 *
 *  3. Out of budget. Deliberately NOT an error: the whole point of the spend
 *     ceiling is to reach the end of the money with an answer in hand, rather
 *     than let the node's wall-clock guard fail the run outright with nothing to
 *     show for what it already spent.
 *
 *  4. Only then, the opt-in that DEMANDS a tool call — and only on turn 1, so
 *     every later turn is free to answer and the loop can't be trapped.
 */
export function createPrepareStep(
  args: TurnPolicyArgs,
): (opts: { stepNumber: number }) => PreparedStep {
  const {
    state,
    modelId,
    maxTurns,
    answeringModel,
    hasTools,
    contextLength,
    toolTokenBudget,
    sink,
  } = args
  // Tokens to keep free for writing the answer. Null → no window was reported,
  // so rule 2 stands down.
  const answerReserveTokens =
    contextLength != null
      ? Math.floor((contextLength * (args.answerReservePercent ?? 10)) / 100)
      : null
  // Turn 1 can only be forced to call a tool when there IS a tool to call and a
  // later turn survives to answer with the result. `maxTurns: 1` makes turn 1 the
  // final answering turn, which rule 1 denies tools — forcing here would produce
  // a tool call the loop has no room to answer with, i.e. the empty-`text` run
  // rule 1 exists to prevent.
  const forceFirstTool =
    (args.requireToolFirstTurn ?? false) && maxTurns > 1 && hasTools
  const answerNow = (
    message: string,
    meta?: Record<string, unknown>,
  ): PreparedStep => {
    state.stepMustAnswer = true
    void sink?.log?.({ level: 'info', message, meta })
    return { toolChoice: 'none', model: answeringModel }
  }
  return ({ stepNumber }) => {
    const turn = `turn ${stepNumber + 1}/${maxTurns}`
    // Re-decided per step: an agent with no tools always answers, otherwise only
    // the branches below that deny tools qualify.
    state.stepMustAnswer = !hasTools

    if (stepNumber >= maxTurns - 1) {
      return answerNow(`→ ${modelId} (${turn}, answering — no more tools)`)
    }

    // With no growth sample yet (turn 2), the conversation's current size stands
    // in for its growth — i.e. assume it could double. That's deliberately
    // pessimistic and costs nothing in the normal case, where an opening prompt
    // is a rounding error against the window; where it DOES bite, the
    // conversation is already vast and stopping is right.
    if (answerReserveTokens != null && state.lastInputTokens > 0) {
      const growth =
        state.observedGrowth > 0 ? state.observedGrowth : state.lastInputTokens
      const projected = state.lastInputTokens + growth
      if (projected + answerReserveTokens > contextLength!) {
        state.stoppedOnContextLimit = true
        return answerNow(
          `→ ${modelId} (${turn}, another turn would reach ~${projected.toLocaleString()} of ${contextLength!.toLocaleString()} — answering while there is room to)`,
          {
            lastInputTokens: state.lastInputTokens,
            observedGrowth: growth,
            projected,
            answerReserveTokens,
            contextLength,
          },
        )
      }
    }

    const spent = state.totalUsage.inputTokens + state.totalUsage.outputTokens
    if (toolTokenBudget != null && spent >= toolTokenBudget) {
      state.stoppedOnTokenBudget = true
      return answerNow(
        `→ ${modelId} (${turn}, token budget reached at ${spent.toLocaleString()} — answering with what it has)`,
        { spent, toolTokenBudget },
      )
    }

    if (stepNumber === 0 && forceFirstTool) {
      void sink?.log?.({
        level: 'info',
        message: `→ ${modelId} (turn 1/${maxTurns}, tool call required)`,
      })
      return { toolChoice: 'required' }
    }
    return {}
  }
}

export type TurnTraceArgs = {
  state: AgentLoopState
  modelId: string
  maxTurns: number
  /** Stream the model's reasoning to the user's 'progress' channel. */
  streamReasoning: boolean
  /** Announce each tool the model calls on the user's 'progress' channel. */
  streamToolCalls: boolean
  /** Per-tool status templates, keyed by tool id. A tool without one is silent. */
  toolStatusLabels?: Record<string, string>
  sink?: StreamSink
}

/**
 * The after-each-turn seam: record what the turn did, then narrate it twice.
 *
 * `onStepFinish` is the only place a turn's usage, reasoning text and tool
 * results exist — the loop's final result carries the LAST step's text only — so
 * this is where the recorded trace and the context guard's occupancy reading both
 * come from.
 *
 * Two feeds, deliberately separate. The DEV feed (`thinking` / `tool`) is
 * unconditional and powers the run viewer's Logs panel; it never reaches an end
 * user. The USER-FACING feed mirrors the same internals into the curated
 * `progress` level, gated independently by the node's two "Inform user"
 * sub-toggles, so a surface can show reasoning interleaved with human-readable
 * tool statements. `meta.progress` tags WHICH of the two a progress line is, so
 * that surface can render them distinctly (a thinking vs. a tool icon) instead of
 * one undifferentiated list; an untagged progress line is a plain node step (see
 * `emitNodeStartProgress`).
 */
export function createOnStepFinish(
  args: TurnTraceArgs,
): (step: StepResult<ToolSet>) => void {
  const {
    state,
    modelId,
    maxTurns,
    streamReasoning,
    streamToolCalls,
    toolStatusLabels,
    sink,
  } = args
  return (step) => {
    const toolCalls = (step.toolCalls ?? []).map((tc) => {
      const r = step.toolResults?.find((rr) => rr.toolCallId === tc.toolCallId)
      return {
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        input: tc.input as unknown,
        output: r && 'output' in r ? (r.output as unknown) : null,
      }
    })
    state.stepTraces.push({
      stepNumber: step.stepNumber,
      finishReason: step.finishReason,
      reasoning: step.reasoningText,
      text: step.text,
      toolCalls,
      usage: step.usage
        ? {
            inputTokens: step.usage.inputTokens,
            outputTokens: step.usage.outputTokens,
          }
        : undefined,
    })
    state.totalUsage.inputTokens += step.usage?.inputTokens ?? 0
    state.totalUsage.outputTokens += step.usage?.outputTokens ?? 0
    // Not cumulative — this is the size of the conversation as sent for THIS
    // turn, which is exactly what the context guard needs to read. The jump since
    // the previous turn is what one more turn would add again.
    const input = step.usage?.inputTokens
    if (input != null) {
      if (state.lastInputTokens > 0) {
        state.observedGrowth = Math.max(
          state.observedGrowth,
          input - state.lastInputTokens,
        )
      }
      state.lastInputTokens = input
    }
    if (!sink) return

    const reasoning = step.reasoningText?.trim()
    if (reasoning) {
      void sink.log?.({ level: 'thinking', message: reasoning })
    }
    for (const tc of toolCalls) {
      void sink.log?.({
        level: 'tool',
        message: `Called ${tc.toolName}`,
        meta: { tool: tc.toolName, input: tc.input },
      })
    }
    if (streamReasoning && reasoning) {
      void sink.log?.({
        level: 'progress',
        message: reasoning,
        meta: { progress: 'reasoning' },
      })
    }
    if (streamToolCalls) {
      for (const tc of toolCalls) {
        const template = toolStatusLabels?.[tc.toolName]
        const message = template && interpolateUserText(template, tc.input).trim()
        if (message) {
          void sink.log?.({
            level: 'progress',
            message,
            meta: { progress: 'tool', tool: tc.toolName },
          })
        }
      }
    }
    // A step that called tools isn't the last one: the loop is about to open
    // another round-trip, and go quiet again for however long that takes. Mark
    // the boundary so the gap in the feed is attributable.
    if (toolCalls.length > 0 && step.stepNumber + 1 < maxTurns) {
      void sink.log?.({
        level: 'info',
        message: `→ ${modelId} (turn ${step.stepNumber + 2}/${maxTurns})`,
      })
    }
  }
}
