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
}

// generateObject path — for the structured-object and YES/NO output kinds we
// return the parsed object as the node output. No tool loop, no progress.
async function runStructuredGeneration(
  args: RunAgentGenerationArgs,
): Promise<AgentNodeResult> {
  const { model, modelId, output, systemPrompt, messages } = args
  // Only reached for the object / boolean kinds; `object` carries the schema.
  const schema =
    output.kind === 'object' ? output.schema : BOOLEAN_OUTPUT_SCHEMA
  const result = await generateObject({
    model,
    system: systemPrompt,
    messages: await convertToModelMessages(messages),
    schema: jsonSchema(schema),
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
  } = args
  const stepTraces: AgentNodeMeta['steps'] = []
  const totalUsage = { inputTokens: 0, outputTokens: 0 }

  const result = await generateText({
    model,
    system: systemPrompt,
    messages: await convertToModelMessages(messages),
    tools,
    stopWhen: stepCountIs(maxTurns),
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
      }
    },
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
