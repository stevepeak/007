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

// Extracts UIMessage[] from the incoming node input:
//   - If the input already looks like a chat trigger (`{messages: [...]}`),
//     use those messages directly.
//   - Otherwise wrap the stringified input as a single user message so a
//     downstream agent can run on a tool node's output.
export function coerceToMessages(input: unknown): UIMessage[] {
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
