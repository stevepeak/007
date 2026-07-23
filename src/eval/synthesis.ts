import type { UIMessage } from 'ai'

import type { SeededMessage } from './checks'

// Synthesis-mode helpers. A "seeded conversation" (authored on a Sample's
// `initialCondition.seededMessages`) is a compact transcript — user turns plus
// assistant turns that already carry their tool calls and canned results. Two
// consumers turn it into concrete shapes:
//   • `seededMessagesToUiMessages` → the AI-SDK `UIMessage[]` the run starts from
//     (fed as the agent node's input via `{ messages }`, see `coerceToMessages`).
//   • `collectSeededToolCalls`      → the flat tool-call list the LLM judge is
//     shown so it can grade groundedness against the context the model "saw",
//     even though — under `freezeTools` — no real tool step exists in the trace.

/** A tool invocation the model was shown, as the grader/judge consumes it. */
export type SeededToolInvocation = {
  toolId: string
  args: unknown
  output: unknown
}

/**
 * Convert an authored seeded transcript into AI-SDK `UIMessage[]`. Assistant
 * tool calls become `dynamic-tool` parts in the `output-available` state, which
 * `convertToModelMessages` expands into an assistant tool-call turn plus a tool
 * result turn — so the model sees a completed retrieval it can synthesize from.
 */
export function seededMessagesToUiMessages(
  seeded: SeededMessage[],
): UIMessage[] {
  return seeded.map((m): UIMessage => {
    if (m.role === 'user') {
      return {
        id: crypto.randomUUID(),
        role: 'user',
        parts: [{ type: 'text', text: m.text ?? '' }],
      }
    }
    const parts: UIMessage['parts'] = []
    if (m.text) parts.push({ type: 'text', text: m.text })
    for (const tc of m.toolCalls ?? []) {
      parts.push({
        type: 'dynamic-tool',
        toolName: tc.tool,
        toolCallId: crypto.randomUUID(),
        state: 'output-available',
        input: tc.args ?? {},
        output: tc.output ?? {},
      })
    }
    return { id: crypto.randomUUID(), role: 'assistant', parts }
  })
}

/**
 * Flatten the tool calls staged in a seeded transcript. These never appear in
 * the run's step trace (under `freezeTools` the agent calls nothing), so the
 * judge is handed them explicitly to grade whether the final answer stayed
 * faithful to the context it was given.
 */
export function collectSeededToolCalls(
  seeded: SeededMessage[] | undefined,
): SeededToolInvocation[] {
  const calls: SeededToolInvocation[] = []
  for (const m of seeded ?? []) {
    if (m.role !== 'assistant') continue
    for (const tc of m.toolCalls ?? []) {
      calls.push({ toolId: tc.tool, args: tc.args, output: tc.output })
    }
  }
  return calls
}
