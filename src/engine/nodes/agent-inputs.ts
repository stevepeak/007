import type { UIMessage } from 'ai'

import { resolveBinding } from '../binding'
import { isBlobRef, type WfBlobRef } from '../blob-ref'
import type { ResolvedImage } from '../config'
import type { AgentNode } from '../graph'

// Pure input-preparation helpers for the agent node: turn the incoming node
// input into a message list, resolve the node's prompt-variable and image
// bindings against the live output cache, and fold images onto the conversation.
// Kept apart from the orchestration (`agent.ts`) and the model loop
// (`agent-generation.ts`) so each stays a single, testable concern.

// True when a value looks like a chat/trigger payload carrying a message thread
// (`{ messages: [...] }`). The agent node uses this to keep history EXPLICIT: a
// payload is never auto-expanded into the thread — it must be linked via the
// node's `conversation` binding — so an unlinked chat agent starts fresh instead
// of implicitly inheriting the conversation.
export function isMessagesPayload(input: unknown): input is { messages: UIMessage[] } {
  return (
    input !== null &&
    typeof input === 'object' &&
    Array.isArray((input as { messages?: unknown }).messages)
  )
}

// Wraps a single upstream value as one user message — how a tool/iteration-fed
// agent runs on its predecessor's output. It intentionally does NOT expand a
// `{ messages: [...] }` payload into a thread; multi-message history comes only
// from the agent node's explicit `conversation` binding (see `resolveConversation`).
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

// The messages an agent runs on when NO conversation is linked. Prior history is
// explicit (the `conversation` binding), so a chat/trigger payload contributes
// only its CURRENT (last) turn — the agent answers the latest message with no
// prior context, rather than implicitly inheriting the whole thread. A non-payload
// upstream value becomes the single working user message (tool/iteration input).
export function unlinkedMessages(input: unknown): UIMessage[] {
  if (isMessagesPayload(input)) {
    const last = input.messages[input.messages.length - 1]
    return last ? [last] : []
  }
  return coerceToMessages(input)
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
export async function resolveImageInputs(
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
export function attachImages(
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
