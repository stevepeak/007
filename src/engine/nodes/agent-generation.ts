import {
  convertToModelMessages,
  generateObject,
  generateText,
  jsonSchema,
  type LanguageModel,
  stepCountIs,
  type StepResult,
  streamText,
  type ToolSet,
  type UIMessage,
} from 'ai'

import { BOOLEAN_OUTPUT_SCHEMA } from '../agent-output'
import type { AgentOutput } from '../graph'
import type { ModelBudget } from '../model-budget'
import { interpolateUserText } from '../prompt-variables'
import type { StreamSink } from '../stream-sink'

// The shared model-loop core, factored out of `executeAgentNode` so a spawned
// sub-agent (see `nodes/sub-agent.ts`) runs the IDENTICAL generation logic — one
// place owns the generateObject / YES-NO / tool-calling-loop behavior, so the two
// entry points can never drift. Callers resolve the model, system prompt,
// messages, and tool set; this owns only how the model is driven and how the
// result is shaped into an {@link AgentNodeResult}.

export type AgentNodeMeta = {
  model: string
  systemPrompt: string
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
  /** Max rounds of tool-calling before a final answer (text agents only). */
  maxTurns: number
  /**
   * Force turn 1 to call a tool rather than letting the model answer straight
   * away. Inert where it can't hold — no tools, `maxTurns: 1`, or a structured
   * output kind (no tool loop). See `requireToolFirstTurn` on `AgentConfig`.
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

/**
 * Arm the total-budget guard for one generation.
 *
 * We use our OWN controller rather than the AI SDK's `timeout.totalMs` so the
 * catch can tell an overrun from a stall by identity (`signal.aborted`) instead
 * of matching a `DOMException` message. That distinction drives the two
 * behaviors: a stalled round-trip is transient and the node is retried, while a
 * node that burns its entire budget is failed outright — retrying it would just
 * repeat the same work and hit the same wall.
 */
function armTotalBudget(budget: ModelBudget | undefined): {
  signal?: AbortSignal
  overran: () => boolean
  disarm: () => void
} {
  if (!budget) return { overran: () => false, disarm: () => {} }
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(
      new DOMException(
        `Agent exceeded its total budget of ${Math.round(budget.totalMs / 1000)}s`,
        'TimeoutError',
      ),
    )
  }, budget.totalMs)
  return {
    signal: controller.signal,
    overran: () => controller.signal.aborted,
    disarm: () => {
      clearTimeout(timer)
    },
  }
}

/** Marks a total-budget overrun so the dispatch can fail the run rather than
 * retry it. Set on the error as it leaves this module. */
export const TOTAL_BUDGET_OVERRUN = 'wfTotalBudgetOverrun'

/** Marks an agent that finished its loop without writing any answer text. Like
 * a budget overrun, retrying it just repeats the same expensive dead end. */
export const AGENT_NO_OUTPUT = 'wfAgentNoOutput'

function markOverrun(err: unknown): unknown {
  if (err != null && typeof err === 'object') {
    ;(err as Record<string, unknown>)[TOTAL_BUDGET_OVERRUN] = true
  }
  return err
}

function markNoOutput(err: Error): Error {
  ;(err as unknown as Record<string, unknown>)[AGENT_NO_OUTPUT] = true
  return err
}

/** True for an error the engine should fail outright instead of retrying — the
 * second attempt would deterministically reach the same wall. */
export function isFatalAgentError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false
  const e = err as Record<string, unknown>
  return e[TOTAL_BUDGET_OVERRUN] === true || e[AGENT_NO_OUTPUT] === true
}

// A model call is the longest thing a run does with nothing to say about
// itself: `generateText` is non-streaming, so its per-step callback can't fire
// until a whole round-trip (thinking included) lands — minutes, on a reasoning
// model. Bookending the call gives the feed a heartbeat at the two moments that
// actually exist without streaming: dispatch and outcome. `info` is the dev
// feed; `progress` (the user-facing level) is deliberately untouched here.
function logModelCallStart(
  sink: StreamSink | undefined,
  modelId: string,
  detail: Record<string, unknown>,
): number {
  void sink?.log?.({
    level: 'info',
    message: `→ ${modelId}`,
    meta: detail,
  })
  return Date.now()
}

function logModelCallEnd(
  sink: StreamSink | undefined,
  modelId: string,
  startedAt: number,
  detail: Record<string, unknown>,
): void {
  void sink?.log?.({
    level: 'info',
    message: `← ${modelId} (${Math.round((Date.now() - startedAt) / 1000)}s)`,
    meta: detail,
  })
}

/**
 * Run one generation under its budget guard, logging and classifying a failure.
 *
 * The log line matters as much as the classification: a failed model call is
 * otherwise completely silent (`onStepFinish` never fires on the error path),
 * which is what made a stall indistinguishable from a hung run. Tagging a total
 * overrun here — while the error object is still ours, before it crosses the
 * `step.do` boundary and gets reconstructed — is what lets the dispatch decide
 * between retrying the node and failing the run.
 */
async function runGuarded<T>(
  sink: StreamSink | undefined,
  modelId: string,
  startedAt: number,
  guard: { overran: () => boolean; disarm: () => void },
  body: () => Promise<T>,
): Promise<T> {
  try {
    return await body()
  } catch (err) {
    const elapsed = Math.round((Date.now() - startedAt) / 1000)
    const overran = guard.overran()
    const reason = overran
      ? 'exceeded its total budget'
      : isTimeoutError(err)
        ? 'stalled'
        : 'failed'
    void sink?.log?.({
      level: 'error',
      message: `✕ ${modelId} ${reason} after ${elapsed}s`,
      meta: { elapsedSeconds: elapsed, totalBudgetOverrun: overran },
    })
    throw overran ? markOverrun(err) : err
  } finally {
    guard.disarm()
  }
}

/** A watchdog firing — ours (total budget) or the AI SDK's (per round-trip,
 * per tool). Both surface as a `TimeoutError`-named DOMException. */
function isTimeoutError(err: unknown): boolean {
  return (
    err != null &&
    typeof err === 'object' &&
    'name' in err &&
    (err as { name?: unknown }).name === 'TimeoutError'
  )
}

// generateObject path — for the structured-object and YES/NO output kinds we
// return the parsed object as the node output. No tool loop, no progress.
async function runStructuredGeneration(
  args: RunAgentGenerationArgs,
): Promise<AgentNodeResult> {
  const { model, modelId, output, systemPrompt, messages, sink, budget } = args
  // Only reached for the object / boolean kinds; `object` carries the schema.
  const schema =
    output.kind === 'object' ? output.schema : BOOLEAN_OUTPUT_SCHEMA
  const startedAt = logModelCallStart(sink, modelId, { mode: output.kind })
  // `generateObject` accepts no `timeout` config — only `abortSignal` — but it
  // is a single round-trip anyway, so the total budget is the only bound needed.
  const guard = armTotalBudget(budget)
  const messagesForModel = await convertToModelMessages(messages)
  const result = await runGuarded(sink, modelId, startedAt, guard, () =>
    generateObject({
      model,
      system: systemPrompt,
      messages: messagesForModel,
      schema: jsonSchema(schema),
      abortSignal: guard.signal,
    }),
  )
  logModelCallEnd(sink, modelId, startedAt, {
    finishReason: result.finishReason,
  })
  const meta: AgentNodeMeta = {
    model: modelId,
    systemPrompt,
    steps: [
      {
        stepNumber: 0,
        finishReason: result.finishReason,
        text: JSON.stringify(result.object),
        toolCalls: [],
        usage: result.usage
          ? {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
            }
          : undefined,
      },
    ],
    totalUsage: {
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
    },
  }
  const obj = result.object as Record<string, unknown>
  // A YES/NO agent doubles as a decision: its `answer` routes the node's
  // yes/no edges (the `object` kind produces data only, never routes). The
  // full `{ answer, reason }` still flows downstream as the node's output.
  if (output.kind === 'boolean') {
    return {
      output: obj,
      meta,
      decision: obj.answer ? 'yes' : 'no',
      decisionReasoning: typeof obj.reason === 'string' ? obj.reason : '',
    }
  }
  return { output: obj, meta }
}

// Tool-calling agent loop. Background execution is non-streaming
// (`generateText`); per-step text is forwarded to the sink for live progress.
async function runToolLoop(
  args: RunAgentGenerationArgs,
): Promise<AgentNodeResult> {
  const {
    model,
    modelId,
    maxTurns,
    requireToolFirstTurn,
    toolTokenBudget,
    contextLength,
    answerReservePercent,
    streamReasoning,
    streamToolCalls,
    systemPrompt,
    messages,
    tools,
    toolStatusLabels,
    sink,
    budget,
  } = args
  // Turn 1 can only be forced to call a tool when there IS a tool to call and a
  // later turn survives to answer with the result. `maxTurns: 1` makes turn 1 the
  // final answering turn, which denies tools below — forcing here would produce a
  // tool call the loop has no room to answer with, i.e. the empty-`text` run the
  // final-turn rule exists to prevent.
  const forceFirstTool =
    (requireToolFirstTurn ?? false) &&
    maxTurns > 1 &&
    Object.keys(tools).length > 0
  // Overflow guard. `inputTokens` of a round-trip IS the conversation as sent, so
  // occupancy needs no estimation — but it can only be read AFTER sending, which
  // makes every reading one turn stale. A naive "stop at N% full" therefore has
  // to leave enough slack for one more turn's growth on top of the answer, and
  // the author has no way to know how much that is: it's the size of their tool
  // results, which they've never measured.
  //
  // So the engine measures it. `observedGrowth` is the largest turn-over-turn
  // jump seen so far — deliberately the max, not the last, because a single fat
  // tool result is exactly the thing that overflows the next request. The loop
  // stops once `lastInput + growth` would leave less than the answer reserve.
  // An agent with small tool results rides much closer to the window than a
  // fixed percentage would have allowed; one with huge results stops sooner.
  const answerReserveTokens =
    contextLength != null
      ? Math.floor((contextLength * (answerReservePercent ?? 10)) / 100)
      : null
  let lastInputTokens = 0
  let observedGrowth = 0
  let stoppedOnTokenBudget = false
  let stoppedOnContextLimit = false
  const stepTraces: AgentNodeMeta['steps'] = []
  const totalUsage = { inputTokens: 0, outputTokens: 0 }
  const guard = armTotalBudget(budget)

  // Heartbeat before the loop opens. Until `onStepFinish` fires — a full model
  // round-trip away — this is the only evidence the node is alive, so it names
  // what it's about to do rather than just that it started.
  const startedAt = logModelCallStart(sink, modelId, {
    tools: Object.keys(tools),
    maxTurns,
    budgetSeconds: budget && Math.round(budget.totalMs / 1000),
  })
  const messagesForModel = await convertToModelMessages(messages)

  // Whether this generation streams its answer, and when.
  //
  // WHETHER: the sink was given a `delta` channel — which happens only on a
  // backend that can carry a token stream (inline), and only for the node whose
  // output IS the run's answer. See `StreamSink.delta`.
  //
  // WHEN is the subtler half. `result.text` is the FINAL step's text, not the
  // concatenation across steps, so streaming every delta would show the reader
  // any preamble an intermediate tool-calling turn wrote ("Let me search…") and
  // then leave it stranded above the real answer — text already sent cannot be
  // retracted, and the settled message would disagree with what was on screen.
  //
  // So deltas are forwarded only from a step we KNOW must answer: one where
  // `prepareStep` denied tools, or where the agent has no tools to call. What
  // the reader sees is then exactly the final step's text, byte for byte, and
  // the bridge's reconciliation against `wf_run.output` is a clean no-op.
  //
  // The conservative direction is the safe one: a step we can't prove is the
  // answer simply isn't streamed, which is the pre-streaming behaviour.
  const streamAnswer = typeof sink?.delta === 'function'
  const hasTools = Object.keys(tools).length > 0
  let stepMustAnswer = false

  const callOptions = {
      model,
      system: systemPrompt,
      messages: messagesForModel,
      tools,
      stopWhen: stepCountIs(maxTurns),
      // The last turn is for answering, not for opening another line of
      // research the loop has no room to follow up on. Without this, a model
      // that spends every turn calling tools stops mid-investigation and
      // `result.text` is the empty string — a completed run with nothing in it,
      // which is how a $0.64 chat turn rendered as a blank message. Denying
      // tools on the final turn forces the model to commit what it has to
      // prose, caveats and all, which is what the reader needed anyway.
      // Three rules, in strict precedence. The two that DENY tools come first and
      // are never overridden: whatever else is configured, an agent that is out
      // of turns or out of budget has to write its answer now.
      prepareStep: ({ stepNumber }) => {
        // Re-decided per step: an agent with no tools always answers, otherwise
        // only the branches below that deny tools qualify. See `streamAnswer`.
        stepMustAnswer = !hasTools
        if (stepNumber >= maxTurns - 1) {
          stepMustAnswer = true
          void sink?.log?.({
            level: 'info',
            message: `→ ${modelId} (turn ${stepNumber + 1}/${maxTurns}, answering — no more tools)`,
          })
          return { toolChoice: 'none' as const }
        }
        // Would one more tool turn leave room to write the answer? Checked BEFORE
        // the spend budget because overflowing the window is a hard error and
        // the budget is a preference.
        //
        // With no growth sample yet (turn 2), the conversation's current size
        // stands in for its growth — i.e. assume it could double. That's
        // deliberately pessimistic and costs nothing in the normal case, where an
        // opening prompt is a rounding error against the window; where it DOES
        // bite, the conversation is already vast and stopping is right.
        if (answerReserveTokens != null && lastInputTokens > 0) {
          const growth = observedGrowth > 0 ? observedGrowth : lastInputTokens
          const projected = lastInputTokens + growth
          if (projected + answerReserveTokens > contextLength!) {
            stoppedOnContextLimit = true
            stepMustAnswer = true
            void sink?.log?.({
              level: 'info',
              message: `→ ${modelId} (turn ${stepNumber + 1}/${maxTurns}, another turn would reach ~${projected.toLocaleString()} of ${contextLength!.toLocaleString()} — answering while there is room to)`,
              meta: {
                lastInputTokens,
                observedGrowth: growth,
                projected,
                answerReserveTokens,
                contextLength,
              },
            })
            return { toolChoice: 'none' as const }
          }
        }
        // Spend ceiling reached. Deliberately NOT an error: the whole point of
        // the budget is to reach the end of the money with an answer in hand,
        // rather than let the node's wall-clock guard fail the run outright with
        // nothing to show for what it already spent.
        const spent = totalUsage.inputTokens + totalUsage.outputTokens
        if (toolTokenBudget != null && spent >= toolTokenBudget) {
          stoppedOnTokenBudget = true
          stepMustAnswer = true
          void sink?.log?.({
            level: 'info',
            message: `→ ${modelId} (turn ${stepNumber + 1}/${maxTurns}, token budget reached at ${spent.toLocaleString()} — answering with what it has)`,
            meta: { spent, toolTokenBudget },
          })
          return { toolChoice: 'none' as const }
        }
        // Opt-in: deny the model the option of answering turn 1 from what it
        // already "knows". Only turn 1 — every later turn is free to answer, so
        // this buys a first look at the tools without trapping the loop.
        if (stepNumber === 0 && forceFirstTool) {
          void sink?.log?.({
            level: 'info',
            message: `→ ${modelId} (turn 1/${maxTurns}, tool call required)`,
          })
          return { toolChoice: 'required' as const }
        }
        return {}
      },
      // Per-round-trip and per-tool watchdogs, native to the AI SDK: each is
      // armed and cleared around its own call, so a single stalled request or
      // hung tool fails fast instead of silently consuming the node's whole
      // window. `abortSignal` carries our separate total-budget guard.
      timeout: budget && { stepMs: budget.stepMs, toolMs: budget.toolMs },
      abortSignal: guard.signal,
      onStepFinish: (step: StepResult<ToolSet>) => {
        const toolCalls = (step.toolCalls ?? []).map((tc) => {
          const r = step.toolResults?.find(
            (rr) => rr.toolCallId === tc.toolCallId,
          )
          return {
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.input as unknown,
            output: r && 'output' in r ? (r.output as unknown) : null,
          }
        })
        stepTraces.push({
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
        totalUsage.inputTokens += step.usage?.inputTokens ?? 0
        totalUsage.outputTokens += step.usage?.outputTokens ?? 0
        // Not cumulative — this is the size of the conversation as sent for THIS
        // turn, which is exactly what the context guard needs to read. The jump
        // since the previous turn is what one more turn would add again; keep the
        // largest seen, since the guard has to survive the worst tool result this
        // agent actually produces, not the average one.
        const input = step.usage?.inputTokens
        if (input != null) {
          if (lastInputTokens > 0) {
            observedGrowth = Math.max(observedGrowth, input - lastInputTokens)
          }
          lastInputTokens = input
        }
        if (sink) {
          // DEV feed (always): the model's reasoning + a raw line per tool call.
          // These power the run viewer's Logs panel and never reach the end user.
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
          // USER-FACING feed: mirror the agent's internals into the curated
          // `progress` level so the end-user progress surface can show reasoning
          // interleaved with human-readable tool statements. Each stream is gated
          // independently (the node's dynamic "Inform user" sub-toggles): reasoning
          // by `streamReasoning`, tool announcements by `streamToolCalls`. A tool
          // without a `statusLabel` template contributes nothing.
          //
          // `meta.progress` tags WHICH of the two a line is, so a progress
          // surface can render them distinctly (a thinking vs a tool icon)
          // instead of one undifferentiated list. An untagged progress line is
          // a plain node step (see `emitNodeStartProgress`).
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
              const message =
                template && interpolateUserText(template, tc.input).trim()
              if (message) {
                void sink.log?.({
                  level: 'progress',
                  message,
                  meta: { progress: 'tool', tool: tc.toolName },
                })
              }
            }
          }
          // A step that called tools isn't the last one: the loop is about to
          // open another round-trip, and go quiet again for however long that
          // takes. Mark the boundary so the gap in the feed is attributable.
          if (toolCalls.length > 0 && step.stepNumber + 1 < maxTurns) {
            void sink.log?.({
              level: 'info',
              message: `→ ${modelId} (turn ${step.stepNumber + 2}/${maxTurns})`,
            })
          }
        }
      },
  }

  // ONE options object, driven two ways. `streamText` and `generateText` take
  // the same arguments, so the loop's whole policy — the turn ceiling, the
  // context guard, the spend budget, the watchdogs, the step tracing — is
  // shared verbatim rather than reimplemented per path. The only difference is
  // how the result is obtained, which is exactly the difference that matters.
  //
  // Both run INSIDE `runGuarded`: with `streamText`, failures surface while the
  // stream is consumed or when the final promises are awaited, not when the
  // call is made, so consuming has to happen where the guard can classify a
  // stall from a budget overrun.
  const result = await runGuarded(sink, modelId, startedAt, guard, async () => {
    if (!streamAnswer) return await generateText(callOptions)
    const stream = streamText(callOptions)
    let streamedChars = 0
    for await (const part of stream.fullStream) {
      if (part.type === 'text-delta' && stepMustAnswer && part.text) {
        streamedChars += part.text.length
        await sink?.delta?.(part.text)
      }
    }
    // Whether the answer actually streamed is otherwise invisible — the deltas
    // are unpersisted by design, so a run that quietly fell back to delivering
    // its answer in one piece looks identical afterwards to one that streamed.
    // Say so in the feed, where it can be read against the run that produced it.
    void sink?.log?.({
      level: 'info',
      message: streamedChars
        ? `⇢ streamed ${streamedChars} chars of the answer live`
        : '⇢ answer not streamed (no step was forced to answer; delivered whole)',
      meta: { streamedChars },
    })
    // Awaited after the stream is drained, so these are settled.
    return {
      text: await stream.text,
      finishReason: await stream.finishReason,
    }
  })
  logModelCallEnd(sink, modelId, startedAt, {
    finishReason: result.finishReason,
    steps: stepTraces.length,
    ...totalUsage,
  })

  // A text agent that returns nothing has failed, and must say so here. The
  // node itself is happy to hand an empty string downstream, and everything
  // after it — the Output node, the chat message — faithfully carries the
  // emptiness all the way to a blank bubble the reader can only read as "it
  // broke, silently". `prepareStep` above removes the ordinary cause; anything
  // still landing here is a genuine fault, so name it and fail the run.
  if (result.text.trim() === '') {
    throw markNoOutput(
      new Error(
        `Agent produced no answer after ${stepTraces.length} of ${maxTurns} turns ` +
          `(finish reason: ${result.finishReason}). It called ` +
          `${stepTraces.reduce((n, s) => n + s.toolCalls.length, 0)} tools and wrote no text.`,
      ),
    )
  }

  return {
    output: { text: result.text },
    meta: {
      model: modelId,
      systemPrompt,
      steps: stepTraces,
      totalUsage,
      ...(stoppedOnTokenBudget ? { stoppedOnTokenBudget: true } : {}),
      ...(stoppedOnContextLimit ? { stoppedOnContextLimit: true } : {}),
    },
  }
}

export async function runAgentGeneration(
  args: RunAgentGenerationArgs,
): Promise<AgentNodeResult> {
  if (args.output.kind === 'object' || args.output.kind === 'boolean') {
    return await runStructuredGeneration(args)
  }
  return await runToolLoop(args)
}
