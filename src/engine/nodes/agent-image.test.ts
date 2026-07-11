import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, test } from 'bun:test'

import { makeBlobRef } from '../blob-ref'
import type { ResolvedImage } from '../config'
import type { AgentNode, WfRunManifestEntry } from '../graph'
import { executeAgentNode } from './agent'

// Proves #4: an agent node's `imageInputs` reach the model as an image part —
// a WfBlobRef read through the host `resolveImage`, and an already-formed
// `{ url, mediaType }` passed straight through. We capture the prompt the model
// receives and look for a file/image part carrying the resolved URL.

const MANIFEST: WfRunManifestEntry[] = [
  {
    kind: 'agent',
    id: 'vision',
    versionId: 'v1',
    versionNumber: 1,
    name: 'Vision',
    config: {
      modelId: 'mock',
      prompt: 'Describe the image.',
      toolIds: [],
      maxTurns: 1,
      exposeThinking: false,
      output: { kind: 'text' },
    },
  },
]

// Collect the media types of every image/file part across the model's prompt.
// `convertToModelMessages` decodes a UIMessage `file` part (data URL → bytes)
// into a model file part carrying `mediaType`, so asserting the media type is
// the stable way to prove an image reached the model (the URL string itself is
// consumed into bytes).
function imageMediaTypesFromPrompt(prompt: unknown): string[] {
  const types: string[] = []
  const messages = Array.isArray(prompt) ? prompt : []
  for (const m of messages as Array<{ content?: unknown }>) {
    const content = Array.isArray(m.content) ? m.content : []
    for (const part of content as Array<Record<string, unknown>>) {
      if (
        (part.type === 'file' || part.type === 'image') &&
        typeof part.mediaType === 'string'
      ) {
        types.push(part.mediaType)
      }
    }
  }
  return types
}

function visionNode(imageInputs: AgentNode['config']['imageInputs']): AgentNode {
  return {
    id: 'agent',
    kind: 'agent',
    label: 'Vision',
    position: { x: 0, y: 0 },
    config: { agentId: 'vision', inputs: {}, imageInputs },
  }
}

function mockModelCapturing(seen: { prompt: unknown }) {
  return new MockLanguageModelV3({
    doGenerate: async (opts) => {
      seen.prompt = (opts as { prompt: unknown }).prompt
      return {
        content: [{ type: 'text', text: 'a plate of food' }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        warnings: [],
      }
    },
  })
}

describe('agent node — image inputs (#4)', () => {
  test('resolves a WfBlobRef image input via resolveImage', async () => {
    const seen: { prompt: unknown } = { prompt: null }
    const resolved: ResolvedImage = {
      url: 'data:image/png;base64,AAAA',
      mediaType: 'image/png',
    }
    const node = visionNode({
      photo: {
        kind: 'ref',
        nodeId: 'src',
        path: 'image',
      },
    })
    const nodeOutputs = new Map<string, unknown>([
      ['src', { image: makeBlobRef({ key: 'photos/dish.png', storage: 'r2' }) }],
    ])

    const result = await executeAgentNode<unknown>({
      node,
      input: 'here is a dish',
      getModel: () => mockModelCapturing(seen),
      toolRegistry: new Map(),
      toolDeps: {},
      promptVariables: {},
      nodeOutputs,
      manifest: MANIFEST,
      resolveImage: async () => resolved,
    })

    expect(result.output).toEqual({ text: 'a plate of food' })
    expect(imageMediaTypesFromPrompt(seen.prompt)).toContain('image/png')
  })

  test('passes an already-formed { url, mediaType } straight through', async () => {
    const seen: { prompt: unknown } = { prompt: null }
    const node = visionNode({
      photo: {
        kind: 'literal',
        // A data URL so the SDK decodes it locally (no network) — proves the
        // pre-resolved `{ url, mediaType }` path without a resolveImage.
        value: { url: 'data:image/gif;base64,AAAA', mediaType: 'image/gif' },
      },
    })
    await executeAgentNode<unknown>({
      node,
      input: 'look',
      getModel: () => mockModelCapturing(seen),
      toolRegistry: new Map(),
      toolDeps: {},
      promptVariables: {},
      nodeOutputs: new Map(),
      manifest: MANIFEST,
      // No resolveImage needed — the value is already resolved.
    })
    expect(imageMediaTypesFromPrompt(seen.prompt)).toContain('image/gif')
  })

  test('a blob-ref image input with no resolver throws', async () => {
    const node = visionNode({
      photo: { kind: 'ref', nodeId: 'src', path: 'image' },
    })
    const nodeOutputs = new Map<string, unknown>([
      ['src', { image: makeBlobRef({ key: 'photos/x.png' }) }],
    ])
    await expect(
      executeAgentNode<unknown>({
        node,
        input: 'x',
        getModel: () => mockModelCapturing({ prompt: null }),
        toolRegistry: new Map(),
        toolDeps: {},
        promptVariables: {},
        nodeOutputs,
        manifest: MANIFEST,
      }),
    ).rejects.toThrow(/no resolveImageRef is configured/)
  })
})
