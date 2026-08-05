import {
  convertToModelMessages,
  generateObject,
  generateText,
  jsonSchema,
  type LanguageModel,
  stepCountIs,
  type StepResult,
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

function markOverrun(err: unknown): unknown {
  if (err != null && typeof err === 'object') {
    ;(err as Record<string, unknown>)[TOTAL_BUDGET_OVERRUN] = true
  }
  return err
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
    streamReasoning,
    streamToolCalls,
    systemPrompt,
    messages,
    tools,
    toolStatusLabels,
    sink,
    budget,
  } = args
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
  const result = await runGuarded(sink, modelId, startedAt, guard, () =>
    generateText({
      model,
      system: systemPrompt,
      messages: messagesForModel,
      tools,
      stopWhen: stepCountIs(maxTurns),
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
          if (streamReasoning && reasoning) {
            void sink.log?.({ level: 'progress', message: reasoning })
          }
          if (streamToolCalls) {
            for (const tc of toolCalls) {
              const template = toolStatusLabels?.[tc.toolName]
              const message =
                template && interpolateUserText(template, tc.input).trim()
              if (message) {
                void sink.log?.({ level: 'progress', message })
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
    }),
  )
  logModelCallEnd(sink, modelId, startedAt, {
    finishReason: result.finishReason,
    steps: stepTraces.length,
    ...totalUsage,
  })

  return {
    output: { text: result.text },
    meta: {
      model: modelId,
      systemPrompt,
      steps: stepTraces,
      totalUsage,
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
