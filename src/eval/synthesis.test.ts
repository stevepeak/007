import { describe, expect, test } from 'bun:test'
import { convertToModelMessages, tool } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { z } from 'zod'

import type { AgentNodeMeta } from '../engine/nodes/agent'
import type { ToolRegistry, WfSdkConfig } from '../engine'
import type { SeededMessage } from './checks'
import { runWorkflowUnderConditions } from './index'
import { collectSeededToolCalls, seededMessagesToUiMessages } from './synthesis'

// Synthesis eval mode. Two layers:
//   1. the pure converters (`seededMessagesToUiMessages` / `collectSeededToolCalls`)
//   2. the end-to-end `freezeTools` behavior through the in-process executor —
//      an agent WITH a tool in its config runs with NO tools, answering from the
//      seeded conversation, so a run grades only the final response.

const seeded: SeededMessage[] = [
  { role: 'user', text: 'What is the filing deadline?' },
  {
    role: 'assistant',
    text: 'Let me search.',
    toolCalls: [
      {
        tool: 'search_rag',
        args: { query: 'filing deadline' },
        output: { chunks: ['Deadline is 30 days after service.'] },
      },
    ],
  },
]

describe('seeded-conversation converters', () => {
  test('seededMessagesToUiMessages emits a dynamic-tool part convertToModelMessages accepts', async () => {
    const ui = seededMessagesToUiMessages(seeded)
    expect(ui).toHaveLength(2)
    expect(ui[0]?.role).toBe('user')
    const toolPart = ui[1]?.parts.find((p) => p.type === 'dynamic-tool')
    expect(toolPart).toMatchObject({
      type: 'dynamic-tool',
      toolName: 'search_rag',
      state: 'output-available',
      output: { chunks: ['Deadline is 30 days after service.'] },
    })
    // The real proof: the AI SDK expands it into model messages without throwing,
    // producing a tool result turn the model can synthesize from.
    const model = await convertToModelMessages(ui)
    const flat = JSON.stringify(model)
    expect(flat).toContain('Deadline is 30 days after service.')
    expect(model.some((m) => m.role === 'tool')).toBe(true)
  })

  test('collectSeededToolCalls flattens assistant tool calls with their outputs', () => {
    expect(collectSeededToolCalls(seeded)).toEqual([
      {
        toolId: 'search_rag',
        args: { query: 'filing deadline' },
        output: { chunks: ['Deadline is 30 days after service.'] },
      },
    ])
    expect(collectSeededToolCalls(undefined)).toEqual([])
  })
})

// A mock model that records the tool names and messages it was handed, so a test
// can assert the tool set was frozen and the seeded conversation arrived.
function capturingModel(seen: { tools: string; prompt: string }) {
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      // The provider spec hands `tools` as an array of function-tool descriptors;
      // stringify so a test can assert a tool name is present or absent.
      seen.tools = JSON.stringify(options.tools ?? [])
      seen.prompt = JSON.stringify(options.prompt)
      return {
        content: [{ type: 'text', text: 'The filing deadline is 30 days.' }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        warnings: [],
      }
    },
  })
}

function config(model: MockLanguageModelV3): WfSdkConfig<unknown> {
  const toolRegistry: ToolRegistry<unknown> = new Map([
    [
      'search_rag',
      {
        id: 'search_rag',
        name: 'Search RAG',
        kind: 'ai-tool',
        description: 'Semantic search.',
        sideEffect: 'read',
        build: () =>
          tool({
            description: 'Semantic search.',
            inputSchema: z.object({ query: z.string() }),
            execute: async () => ({ chunks: ['LIVE — should never run'] }),
          }),
      },
    ],
  ])
  return {
    getModel: () => model,
    listModels: () => [{ id: 'mock', label: 'Mock', providerId: 'mock' }],
    listProviders: () => [{ id: 'mock', label: 'Mock', kind: 'custom' }],
    toolRegistry,
    triggers: {
      chat: {
        description: 'Chat',
        inputSchema: z.object({ messages: z.array(z.unknown()).min(1) }),
      },
    },
    buildRunDeps: () => ({}),
  }
}

const graph = {
  version: 1,
  nodes: [
    { id: 't', kind: 'trigger', label: 'Chat', position: { x: 0, y: 0 }, config: { triggerKind: 'chat' } },
    { id: 'a', kind: 'agent', label: 'Assistant', position: { x: 200, y: 0 }, config: { agentId: 'assistant' } },
    { id: 'o', kind: 'output', label: 'Out', position: { x: 400, y: 0 }, config: {} },
  ],
  edges: [
    { id: 'e1', source: 't', target: 'a', condition: null },
    { id: 'e2', source: 'a', target: 'o', condition: null },
  ],
}

// An agent that DOES declare the search tool — proving freezeTools strips it.
const manifest = [
  {
    kind: 'agent' as const,
    id: 'assistant',
    versionId: 'v1',
    versionNumber: 1,
    name: 'Assistant',
    config: {
      modelId: 'mock',
      prompt: 'Answer from the conversation.',
      toolIds: ['search_rag'],
      maxTurns: 5,
      exposeThinking: false,
      output: { kind: 'text' as const },
    },
  },
]

describe('freezeTools — synthesis mode', () => {
  test('freezeTools strips the agent’s tools; seeded conversation reaches the model', async () => {
    const seen = { tools: '', prompt: '' }
    const run = await runWorkflowUnderConditions({
      name: 'synthesis',
      graph,
      triggerInput: { messages: seededMessagesToUiMessages(seeded) },
      config: config(capturingModel(seen)),
      manifest,
      runContext: { freezeTools: true },
    })

    expect(seen.tools).not.toContain('search_rag') // tool NOT offered
    expect(seen.prompt).toContain('Deadline is 30 days after service.') // seeded ctx arrived
    expect((run.output as { text: string }).text).toBe(
      'The filing deadline is 30 days.',
    )
  })

  test('without freezeTools, the same agent IS offered its tool', async () => {
    const seen = { tools: '', prompt: '' }
    await runWorkflowUnderConditions({
      name: 'baseline-tools',
      graph,
      triggerInput: { messages: seededMessagesToUiMessages(seeded) },
      config: config(capturingModel(seen)),
      manifest,
    })

    expect(seen.tools).toContain('search_rag') // tool present on the normal path
  })

  test('the frozen run still records a gradable agent step', async () => {
    const seen = { tools: '', prompt: '' }
    const run = await runWorkflowUnderConditions({
      name: 'synthesis-trace',
      graph,
      triggerInput: { messages: seededMessagesToUiMessages(seeded) },
      config: config(capturingModel(seen)),
      manifest,
      runContext: { freezeTools: true },
    })
    const meta = run.steps.find((s) => s.nodeKind === 'agent')?.meta as AgentNodeMeta
    expect(meta.model).toBe('mock')
    expect(meta.steps.length).toBeGreaterThan(0)
  })
})
