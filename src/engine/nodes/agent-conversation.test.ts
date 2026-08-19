import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, test } from 'bun:test'

import type { AgentConfig, AgentNode, WfRunManifestEntry } from '../graph'
import { executeAgentNode } from './agent'

// Proves how an agent node's messages are built — and, just as importantly, that
// NOTHING else can build them. A task agent runs on its own `userPrompt`; a
// conversation agent runs on the thread its node binds, and fails loudly without
// one. The node's incoming edge contributes nothing in either case: it is
// sequencing and a source for `ref` bindings, never content.
//
// We capture the model's prompt and read the user-turn text back to see exactly
// what reached it.

function manifest(config: Partial<AgentConfig>): WfRunManifestEntry[] {
  return [
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
        userPrompt: '',
        inputKind: 'task',
        toolIds: [],
        maxTurns: 1,
        output: { kind: 'text' },
        ...config,
      } as AgentConfig,
    },
  ]
}

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

function botNode(
  conversation?: AgentNode['config']['conversation'],
  inputs: AgentNode['config']['inputs'] = {},
): AgentNode {
  return {
    id: 'agent',
    kind: 'agent',
    label: 'Chat Bot',
    position: { x: 0, y: 0 },
    informUser: { mode: 'off' },
    config: { agentId: 'bot', version: null, inputs, conversation },
  }
}

const uiMessage = (text: string) => ({
  id: text,
  role: 'user' as const,
  parts: [{ type: 'text' as const, text }],
})

const run = async (args: {
  node: AgentNode
  manifest: WfRunManifestEntry[]
  nodeOutputs?: Map<string, unknown>
  seen: { prompt: unknown }
}) =>
  executeAgentNode<unknown>({
    node: args.node,
    getModel: () => mockModelCapturing(args.seen),
    toolRegistry: new Map(),
    toolDeps: {},
    promptVariables: {},
    nodeOutputs: args.nodeOutputs ?? new Map(),
    manifest: args.manifest,
  })

describe('agent node — task input kind', () => {
  test('the user turn is the rendered userPrompt, and nothing else', async () => {
    const seen: { prompt: unknown } = { prompt: null }
    await run({
      node: botNode(undefined, {
        recipe: { kind: 'ref', nodeId: 'detail', path: 'name' },
      }),
      manifest: manifest({ userPrompt: 'Price this: ${recipe}' }),
      nodeOutputs: new Map<string, unknown>([
        ['detail', { name: 'Boeuf Bourguignon', steps: ['secret step'] }],
      ]),
      seen,
    })
    const text = userTextFromPrompt(seen.prompt)
    expect(text).toContain('Price this: Boeuf Bourguignon')
    // The binding took `name`; the rest of the upstream output stayed behind.
    expect(text).not.toContain('secret step')
  })

  test('an upstream output reaches the model ONLY through a binding', async () => {
    const seen: { prompt: unknown } = { prompt: null }
    await run({
      node: botNode(),
      manifest: manifest({ userPrompt: 'Summarize.' }),
      nodeOutputs: new Map<string, unknown>([
        ['upstream', { leaked: 'edge payload' }],
      ]),
      seen,
    })
    const text = userTextFromPrompt(seen.prompt)
    expect(text).toBe('Summarize.')
    expect(text).not.toContain('edge payload')
  })

  test('a whole upstream output can be passed deliberately, as JSON', async () => {
    const seen: { prompt: unknown } = { prompt: null }
    await run({
      node: botNode(undefined, {
        content: { kind: 'ref', nodeId: 'upstream', path: '' },
      }),
      manifest: manifest({ userPrompt: 'foobar ${content}' }),
      nodeOutputs: new Map<string, unknown>([
        ['upstream', { a: 1, b: 'two' }],
      ]),
      seen,
    })
    expect(userTextFromPrompt(seen.prompt)).toBe(
      'foobar {"a":1,"b":"two"}',
    )
  })

  test('a bound conversation is ignored by a task agent', async () => {
    const seen: { prompt: unknown } = { prompt: null }
    await run({
      node: botNode({ kind: 'ref', nodeId: 'trigger', path: 'messages' }),
      manifest: manifest({ userPrompt: 'Just this.' }),
      nodeOutputs: new Map<string, unknown>([
        ['trigger', { messages: [uiMessage('stale history')] }],
      ]),
      seen,
    })
    const text = userTextFromPrompt(seen.prompt)
    expect(text).toBe('Just this.')
    expect(text).not.toContain('stale history')
  })
})

describe('agent node — conversation input kind', () => {
  const conversational = (userPrompt = '') =>
    manifest({ inputKind: 'conversation', userPrompt })

  test('the bound thread is the history', async () => {
    const seen: { prompt: unknown } = { prompt: null }
    await run({
      node: botNode({ kind: 'ref', nodeId: 'trigger', path: 'messages' }),
      manifest: conversational(),
      nodeOutputs: new Map<string, unknown>([
        ['trigger', { messages: [uiMessage('prior turn'), uiMessage('current question')] }],
      ]),
      seen,
    })
    const text = userTextFromPrompt(seen.prompt)
    // The WHOLE thread, not just its last turn: history is what a chat agent is for.
    expect(text).toContain('prior turn')
    expect(text).toContain('current question')
  })

  test('a userPrompt is appended after the thread as the current turn', async () => {
    const seen: { prompt: unknown } = { prompt: null }
    await run({
      node: botNode({ kind: 'ref', nodeId: 'trigger', path: 'messages' }),
      manifest: conversational('Now summarize the thread.'),
      nodeOutputs: new Map<string, unknown>([
        ['trigger', { messages: [uiMessage('prior turn')] }],
      ]),
      seen,
    })
    expect(userTextFromPrompt(seen.prompt)).toBe(
      'prior turn | Now summarize the thread.',
    )
  })

  test('an unbound conversation throws instead of answering with no context', async () => {
    const seen: { prompt: unknown } = { prompt: null }
    await expect(
      run({ node: botNode(), manifest: conversational(), seen }),
    ).rejects.toThrow(/conversation.*not bound/i)
  })

  test('a binding that resolves to a non-array throws too', async () => {
    const seen: { prompt: unknown } = { prompt: null }
    await expect(
      run({
        node: botNode({ kind: 'ref', nodeId: 'trigger', path: 'notMessages' }),
        manifest: conversational(),
        nodeOutputs: new Map<string, unknown>([['trigger', { notMessages: 'oops' }]]),
        seen,
      }),
    ).rejects.toThrow(/conversation.*not bound/i)
  })
})
