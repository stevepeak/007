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
import { PROMPT_VARIABLE_RE } from '../prompt-variables'
import type { StreamSink } from '../stream-sink'

/**
 * Fill a tool's `statusLabel` template (`Searching for ${query}`) from the tool
 * call's input args. Shares the `${token}` grammar with prompt variables. A
 * token whose arg is missing/null resolves to empty string (a user-facing line
 * should never show a raw `${…}`), and values are coerced to strings.
 */
export function interpolateStatus(template: string, input: unknown): string {
  const vars =
    input && typeof input === 'object'
      ? (input as Record<string, unknown>)
      : {}
  return template.replaceAll(PROMPT_VARIABLE_RE, (_match, key: string) => {
    const v = vars[key]
    if (v == null) return ''
    if (typeof v === 'string') return v
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    return JSON.stringify(v)
  })
}

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
  /** Forward per-step text to the sink's 'progress' channel when true. */
  exposeThinking: boolean
  systemPrompt: string
  messages: UIMessage[]
  tools: ToolSet
  /**
   * Per-tool human-readable status templates, keyed by tool id (== the tool name
   * the model calls). When `exposeThinking` is on, a matching template is
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
    exposeThinking,
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
        // Structured feed for the run viewer's Logs panel: the model's internal
        // reasoning, then a line per tool call. These make "what is it doing
        // right now" legible without waiting for the node to finish.
        if (step.reasoningText?.trim()) {
          void sink.log?.({
            level: 'thinking',
            message: step.reasoningText.trim(),
          })
        }
        for (const tc of toolCalls) {
          void sink.log?.({
            level: 'tool',
            message: `Called ${tc.toolName}`,
            meta: { tool: tc.toolName, input: tc.input },
          })
          // User-facing tool-call update: when the placement exposes thinking and
          // the tool ships a human-readable `statusLabel`, stream the filled-in
          // statement to the 'progress' channel (chat) + a mirrored structured
          // line. A tool without a template exposes nothing.
          if (exposeThinking) {
            const template = toolStatusLabels?.[tc.toolName]
            const message = template && interpolateStatus(template, tc.input).trim()
            if (message) {
              void sink.append('progress', message)
              void sink.log?.({ level: 'info', message })
            }
          }
        }
        // The legacy free-text 'progress' channel (chat toasts) + a mirrored
        // structured line, gated by the agent's exposeThinking flag.
        if (exposeThinking && step.text?.trim()) {
          void sink.append('progress', step.text)
          void sink.log?.({ level: 'info', message: step.text.trim() })
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
