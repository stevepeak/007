import {
  convertToModelMessages,
  generateObject,
  generateText,
  jsonSchema,
  stepCountIs,
  type StepResult,
  type ToolSet,
  type UIMessage,
} from 'ai'

import { BOOLEAN_OUTPUT_SCHEMA } from '../agent-output'
import { resolveBinding } from '../binding'
import { isBlobRef, type WfBlobRef } from '../blob-ref'
import type { ModelFactory, ResolvedImage } from '../config'
import {
  agentFromManifest,
  type AgentConfig,
  type AgentNode,
  type WfRunManifestEntry,
} from '../graph'
import type { StreamSink } from '../stream-sink'
import { buildAgentToolSet, type ToolRegistry } from '../tool-registry'

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
}

// Extracts UIMessage[] from the incoming node input:
//   - If the input already looks like a chat trigger (`{messages: [...]}`),
//     use those messages directly.
//   - Otherwise wrap the stringified input as a single user message so a
//     downstream agent can run on a tool node's output.
function coerceToMessages(input: unknown): UIMessage[] {
  if (
    input !== null &&
    typeof input === 'object' &&
    Array.isArray((input as { messages?: unknown }).messages)
  ) {
    return (input as { messages: UIMessage[] }).messages
  }
  const text =
    typeof input === 'string' ? input : JSON.stringify(input ?? '', null, 2)
  return [
    {
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text }],
    } satisfies UIMessage,
  ]
}

// Variable substitution for the system prompt. Unknown `${...}` patterns are
// left intact so the prompt author sees them at runtime rather than silently
// producing empty strings.
function substituteVariables(
  template: string,
  vars: Record<string, string | undefined>,
): string {
  return template.replaceAll(/\$\{(\w+)\}/g, (match, key: string) => {
    return vars[key] ?? match
  })
}

// Resolves the node's per-variable input bindings against the live node-output
// cache, coercing each value to a string for prompt interpolation. Non-string
// values (objects/arrays) are JSON-stringified so a whole upstream output can
// be injected; null/undefined become empty strings. When `rehydrate` is given,
// blob-ref values (a large payload spilled to storage upstream) are read back to
// their real text here — inside this node's step — before interpolation.
async function resolveNodeInputs(
  node: AgentNode,
  nodeOutputs: Map<string, unknown>,
  rehydrate?: (value: unknown) => Promise<unknown>,
): Promise<Record<string, string>> {
  const vars: Record<string, string> = {}
  for (const [name, binding] of Object.entries(node.config.inputs)) {
    let value = resolveBinding(binding, nodeOutputs, {
      nodeId: node.id,
      name,
    })
    if (rehydrate) value = await rehydrate(value)
    vars[name] =
      typeof value === 'string'
        ? value
        : value == null
          ? ''
          : JSON.stringify(value)
  }
  return vars
}

// A model-ready image message part (AI SDK UIMessage `file` part). `url` is a
// data: or http(s) URL; `mediaType` is the image MIME type.
type ImagePart = { type: 'file'; mediaType: string; url: string }

function isResolvedImage(v: unknown): v is ResolvedImage {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { url?: unknown }).url === 'string' &&
    typeof (v as { mediaType?: unknown }).mediaType === 'string'
  )
}

// Resolve the agent node's `imageInputs` bindings into image message parts.
// Each binding resolves to a WfBlobRef (read via the host `resolveImage`) or an
// already-formed `{ url, mediaType }`; null/undefined bindings are skipped.
async function resolveImageInputs(
  node: AgentNode,
  nodeOutputs: Map<string, unknown>,
  resolveImage?: (ref: WfBlobRef) => Promise<ResolvedImage>,
): Promise<ImagePart[]> {
  const entries = Object.entries(node.config.imageInputs)
  if (entries.length === 0) return []
  const parts = await Promise.all(
    entries.map(async ([name, binding]): Promise<ImagePart | null> => {
      const value = resolveBinding(binding, nodeOutputs, {
        nodeId: node.id,
        name,
      })
      if (value == null) return null
      if (isBlobRef(value)) {
        if (!resolveImage) {
          throw new Error(
            `Agent node ${node.id} image input '${name}' is a blob ref but no resolveImageRef is configured.`,
          )
        }
        const img = await resolveImage(value)
        return { type: 'file', mediaType: img.mediaType, url: img.url }
      }
      if (isResolvedImage(value)) {
        return { type: 'file', mediaType: value.mediaType, url: value.url }
      }
      throw new Error(
        `Agent node ${node.id} image input '${name}' did not resolve to an image (expected a blob ref or { url, mediaType }).`,
      )
    }),
  )
  return parts.filter((p): p is ImagePart => p !== null)
}

// Attach image parts to the conversation. If the last message is already a user
// turn, fold them in (avoids two consecutive user messages some providers
// reject); otherwise add a fresh user message carrying just the images.
function attachImages(
  messages: UIMessage[],
  imageParts: ImagePart[],
): UIMessage[] {
  if (imageParts.length === 0) return messages
  const last = messages[messages.length - 1]
  if (last && last.role === 'user') {
    return [
      ...messages.slice(0, -1),
      { ...last, parts: [...last.parts, ...imageParts] },
    ]
  }
  return [
    ...messages,
    {
      id: crypto.randomUUID(),
      role: 'user',
      parts: imageParts,
    } satisfies UIMessage,
  ]
}

export type ExecuteAgentNodeDeps<TDeps> = {
  node: AgentNode
  input: unknown
  getModel: ModelFactory
  toolRegistry: ToolRegistry<TDeps>
  toolDeps: TDeps
  /**
   * Live progress sink. When the node has `stream: true`, each completed
   * step's text is appended as a 'progress' event (e.g. forwarded to the
   * RunRoom DO). Background runs deliver progress here rather than to an HTTP
   * caller.
   */
  sink?: StreamSink
  /** Run-level variables exposed to the system-prompt template engine. */
  promptVariables: Record<string, string | undefined>
  /**
   * Live node-output cache (from `scheduler.getOutputs()`) — used to resolve
   * this node's per-variable input bindings (`config.inputs`) into prompt vars.
   */
  nodeOutputs: Map<string, unknown>
  /** Frozen run manifest — resolves the node's `agentId` to its config. */
  manifest: WfRunManifestEntry[]
  /**
   * Deep-rehydrates blob-ref inputs (a large upstream value spilled to storage)
   * to their real text before prompt interpolation. Omitted → inputs pass
   * through unchanged.
   */
  rehydrate?: (value: unknown) => Promise<unknown>
  /**
   * Resolves an image blob-ref (from an `imageInputs` binding) to a model-ready
   * image. Bound to the run's deps by the caller. Omitted → an image blob-ref
   * input throws (a text-only run wires no image resolver).
   */
  resolveImage?: (ref: WfBlobRef) => Promise<ResolvedImage>
  /** Eval signal — under simulate, side-effecting tools are neutralized. */
  simulate?: boolean
  /** Canned tool outputs consumed under `simulate`. */
  fixtures?: Record<string, unknown>
}

// Resolve the agent an agent node points at from the frozen run manifest. The
// manifest is populated at run start from the agent's latest published version,
// so a run is reproducible even as the agent drifts.
function resolveAgentConfig(
  node: AgentNode,
  manifest: WfRunManifestEntry[],
): AgentConfig {
  const entry = agentFromManifest(manifest, node.config.agentId)
  if (!entry) {
    throw new Error(
      `Agent node ${node.id} references agent ${node.config.agentId || '(none)'}, which is not in the run manifest.`,
    )
  }
  return entry.config
}

export async function executeAgentNode<TDeps>(
  deps: ExecuteAgentNodeDeps<TDeps>,
): Promise<AgentNodeResult> {
  const {
    node,
    getModel,
    toolRegistry,
    toolDeps,
    sink,
    promptVariables,
    nodeOutputs,
    manifest,
    input,
    rehydrate,
    resolveImage,
    simulate,
    fixtures,
  } = deps
  const config = resolveAgentConfig(node, manifest)
  const model = getModel(config.modelId)
  const tools = buildAgentToolSet(toolRegistry, config.toolIds, toolDeps, {
    simulate,
    fixtures,
  })
  // Node-level bound inputs override the run-level promptVariables.
  const vars = {
    ...promptVariables,
    ...(await resolveNodeInputs(node, nodeOutputs, rehydrate)),
  }
  const systemPrompt = substituteVariables(config.prompt, vars)
  // Any bound image inputs ride along as vision parts on the user turn.
  const imageParts = await resolveImageInputs(node, nodeOutputs, resolveImage)
  const messages = attachImages(coerceToMessages(input), imageParts)

  // generateObject path — for the structured-object and YES/NO output kinds we
  // return the parsed object as the node output. No tool loop, no progress.
  if (config.output.kind === 'object' || config.output.kind === 'boolean') {
    const schema =
      config.output.kind === 'boolean'
        ? BOOLEAN_OUTPUT_SCHEMA
        : config.output.schema
    const result = await generateObject({
      model,
      system: systemPrompt,
      messages: await convertToModelMessages(messages),
      schema: jsonSchema(schema),
    })
    const meta: AgentNodeMeta = {
      model: config.modelId,
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
    return { output: result.object as Record<string, unknown>, meta }
  }

  // Tool-calling agent loop. Background execution is non-streaming
  // (`generateText`); per-step text is forwarded to the sink for live progress.
  const stepTraces: AgentNodeMeta['steps'] = []
  const totalUsage = { inputTokens: 0, outputTokens: 0 }

  const result = await generateText({
    model,
    system: systemPrompt,
    messages: await convertToModelMessages(messages),
    tools,
    stopWhen: stepCountIs(config.maxTurns),
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
      if (config.exposeThinking && sink && step.text) {
        void sink.append('progress', step.text)
      }
    },
  })

  return {
    output: { text: result.text },
    meta: {
      model: config.modelId,
      systemPrompt,
      steps: stepTraces,
      totalUsage,
    },
  }
}
