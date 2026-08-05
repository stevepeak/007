import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, test } from 'bun:test'

import type { AgentNode, WfRunManifestEntry } from '../graph'
import { executeAgentNode } from './agent'

// Proves the agent node's optional `conversation` binding: when set, the linked
// message source (typically the chat trigger's `messages`) becomes the agent's
// history — independent of the primary input — and when absent the node falls
// back to the implicit `coerceToMessages(input)` behavior. We capture the model's
// prompt and read back the user-turn text to see which history reached it.

const MANIFEST: WfRunManifestEntry[] = [
  {
    kind: 'agent',
    id: 'bot',
    pinnedVersion: null,
    versionId: 'v1',
    versionNumber: 1,
    name: 'Chat Bot',
    config: {
      modelId: 'mock',
      prompt: 'Answer.',
      toolIds: [],
      maxTurns: 1,
      output: { kind: 'text' },
    },
  },
]

// The text of every user-turn part across the model's prompt, concatenated.
function userTextFromPrompt(prompt: unknown): string {
  const messages = Array.isArray(prompt) ? prompt : []
  const out: string[] = []
  for (const m of messages as Array<{ role?: string; content?: unknown }>) {
    if (m.role !== 'user') continue
    const content = Array.isArray(m.content) ? m.content : []
    for (const part of content as Array<Record<string, unknown>>) {
      if (part.type === 'text' && typeof part.text === 'string') {
        out.push(part.text)
      }
    }
  }
  return out.join(' | ')
}

function mockModelCapturing(seen: { prompt: unknown }) {
  return new MockLanguageModelV3({
    doGenerate: async (opts) => {
      seen.prompt = (opts as { prompt: unknown }).prompt
      return {
        content: [{ type: 'text', text: 'ok' }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      }
    },
  })
}

function botNode(conversation?: AgentNode['config']['conversation']): AgentNode {
  return {
    id: 'agent',
    kind: 'agent',
    label: 'Chat Bot',
    position: { x: 0, y: 0 },
    informUser: { mode: 'off' },
    config: { agentId: 'bot', version: null, inputs: {}, imageInputs: {}, conversation },
  }
}

const uiMessage = (text: string) => ({
  id: text,
  role: 'user' as const,
  parts: [{ type: 'text' as const, text }],
})

describe('agent node — conversation binding', () => {
  test('a bound conversation sources history from the linked node', async () => {
    const seen: { prompt: unknown } = { prompt: null }
    const node = botNode({ kind: 'ref', nodeId: 'trigger', path: 'messages' })
    const nodeOutputs = new Map<string, unknown>([
      ['trigger', { messages: [uiMessage('linked history')] }],
    ])
    await executeAgentNode<unknown>({
      node,
      // The primary input carries DIFFERENT messages — the binding must win.
      input: { messages: [uiMessage('primary-edge history')] },
      getModel: () => mockModelCapturing(seen),
      toolRegistry: new Map(),
      toolDeps: {},
      promptVariables: {},
      nodeOutputs,
      manifest: MANIFEST,
    })
    const text = userTextFromPrompt(seen.prompt)
    expect(text).toContain('linked history')
    expect(text).not.toContain('primary-edge history')
  })

  test('no link: a chat payload contributes only its CURRENT turn, no prior thread', async () => {
    const seen: { prompt: unknown } = { prompt: null }
    await executeAgentNode<unknown>({
      node: botNode(),
      input: {
        messages: [uiMessage('older prior turn'), uiMessage('current question')],
      },
      getModel: () => mockModelCapturing(seen),
      toolRegistry: new Map(),
      toolDeps: {},
      promptVariables: {},
      nodeOutputs: new Map(),
      manifest: MANIFEST,
    })
    const text = userTextFromPrompt(seen.prompt)
    // Explicit-only: without a conversation link the prior history is dropped.
    expect(text).toContain('current question')
    expect(text).not.toContain('older prior turn')
  })

  test('no link: a non-payload upstream value becomes the single user message', async () => {
    const seen: { prompt: unknown } = { prompt: null }
    await executeAgentNode<unknown>({
      node: botNode(),
      input: 'summarize this document',
      getModel: () => mockModelCapturing(seen),
      toolRegistry: new Map(),
      toolDeps: {},
      promptVariables: {},
      nodeOutputs: new Map(),
      manifest: MANIFEST,
    })
    expect(userTextFromPrompt(seen.prompt)).toContain('summarize this document')
  })

  test('a non-array bound value falls back to the current-turn behavior', async () => {
    const seen: { prompt: unknown } = { prompt: null }
    const node = botNode({ kind: 'ref', nodeId: 'trigger', path: 'notMessages' })
    const nodeOutputs = new Map<string, unknown>([
      ['trigger', { notMessages: 'oops' }],
    ])
    await executeAgentNode<unknown>({
      node,
      input: { messages: [uiMessage('older'), uiMessage('current question')] },
      getModel: () => mockModelCapturing(seen),
      toolRegistry: new Map(),
      toolDeps: {},
      promptVariables: {},
      nodeOutputs,
      manifest: MANIFEST,
    })
    const text = userTextFromPrompt(seen.prompt)
    expect(text).toContain('current question')
    expect(text).not.toContain('older')
  })
})
