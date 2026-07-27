import {
  convertToModelMessages,
  type LanguageModel,
  type ModelMessage,
  stepCountIs,
  streamText,
  type ToolSet,
  type UIMessage,
} from 'ai'

// The copilot's agentic loop: one streaming `streamText` that may call tools
// across several steps until it answers or hits the step cap. Mirrors the
// engine's agent node (generateText + stopWhen: stepCountIs), but streaming so
// tokens + tool calls flow to the UI live. Ephemeral — nothing is persisted.
//
// Returns the ready UIMessage-stream `Response` (rather than the raw
// `StreamTextResult`) so this exported function's return type stays nameable in
// the package's declaration build — the AI SDK's result type references an
// internal `Output` type that can't be re-exported.
export async function runCopilot({
  model,
  system,
  messages,
  tools,
  maxSteps = 12,
}: {
  model: LanguageModel
  system: string
  messages: UIMessage[]
  tools: ToolSet
  maxSteps?: number
}): Promise<Response> {
  const modelMessages: ModelMessage[] = await convertToModelMessages(messages)
  const result = streamText({
    model,
    system,
    messages: modelMessages,
    tools,
    stopWhen: stepCountIs(maxSteps),
  })
  return result.toUIMessageStreamResponse()
}
