import type { UIMessage } from 'ai'

import type { AgentConfig } from '../agent-config-schema'
import { resolveBinding } from '../binding'
import type { AgentNode } from '../graph'

// Pure input-preparation helpers for the agent node: build its messages from the
// declared templates and bindings, and resolve its prompt-variable bindings
// against the live output cache. Kept apart from the orchestration (`agent.ts`)
// and the model loop (`agent-generation.ts`) so each stays a single, testable
// concern.
//
// Nothing here reads the node's incoming `input`. An edge carries sequencing and
// gives `ref` bindings something to point at; it is never itself content.

// Wraps a single value as one user message. The delegation path uses it to turn
// a spawned sub-agent's task string into its opening turn (see `sub-agent.ts`);
// nothing else may fabricate a turn from an arbitrary value.
export function coerceToMessages(input: unknown): UIMessage[] {
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

/**
 * Build the messages an agent node runs on. Everything here is declared: the
 * author writes a user template (task) or binds a thread (conversation), and an
 * incoming edge contributes nothing on its own.
 *
 *  • task         — exactly one user turn, the interpolated `userPrompt`. Its
 *                   non-emptiness is guaranteed by `agentConfigSchema`, so the
 *                   AI SDK's "messages must not be empty" can't be reached.
 *  • conversation — the bound thread, with the interpolated `userPrompt`
 *                   appended as the current turn when the author wrote one.
 *
 * An unbound conversation THROWS rather than degrading. The old fallback made a
 * mis-wired chat agent look like it worked while answering with no context; a
 * missing binding is an authoring bug and reads better as one.
 */
export async function buildAgentMessages(args: {
  inputKind: AgentConfig['inputKind']
  /** `userPrompt` with its `${vars}` already substituted. */
  userPrompt: string
  node: AgentNode
  nodeOutputs: Map<string, unknown>
  rehydrate?: (value: unknown) => Promise<unknown>
}): Promise<UIMessage[]> {
  const { inputKind, userPrompt, node, nodeOutputs, rehydrate } = args
  const turn = (text: string): UIMessage => ({
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text }],
  })

  if (inputKind === 'task') return [turn(userPrompt)]

  const linked = await resolveConversation(node, nodeOutputs, rehydrate)
  if (!linked) {
    throw new Error(
      `Agent node ${node.id} works on a conversation but its \`conversation\` input is not bound to a message source. Bind it in the workflow editor (usually the chat trigger's \`messages\`).`,
    )
  }
  return userPrompt.trim().length > 0 ? [...linked, turn(userPrompt)] : linked
}

// Resolves the agent node's optional `conversation` binding to a message list.
// When the node declares one (typically a `ref` into the chat trigger's
// `messages`), that binding is the explicit source of the agent's history; the
// resolved value is returned only when it's actually an array, so a mis-bound
// non-array falls back to the implicit primary-input path in the caller. As with
// prompt vars, a `rehydrate` reads back a value spilled to blob storage upstream.
// Returns undefined when no binding is set (legacy implicit behavior applies).
export async function resolveConversation(
  node: AgentNode,
  nodeOutputs: Map<string, unknown>,
  rehydrate?: (value: unknown) => Promise<unknown>,
): Promise<UIMessage[] | undefined> {
  const binding = node.config.conversation
  if (!binding) return undefined
  let value = resolveBinding(binding, nodeOutputs, {
    nodeId: node.id,
    name: 'conversation',
  })
  if (rehydrate) value = await rehydrate(value)
  return Array.isArray(value) ? (value as UIMessage[]) : undefined
}

// Resolves the node's per-variable input bindings against the live node-output
// cache, coercing each value to a string for prompt interpolation. Non-string
// values (objects/arrays) are JSON-stringified so a whole upstream output can
// be injected; null/undefined become empty strings. When `rehydrate` is given,
// blob-ref values (a large payload spilled to storage upstream) are read back to
// their real text here — inside this node's step — before interpolation.
export async function resolveNodeInputs(
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
