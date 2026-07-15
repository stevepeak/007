import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import { makeBlobRef, type ToolRegistry, type WfSdkConfig } from '../engine'
import { runWorkflowUnderConditions } from './index'

// These tests exercise the whole engine integration through the eval harness:
// the pure Scheduler walk, runNode dispatch, the in-process executor, the
// recorder trace, and — crucially — HOST INJECTION of both tools and the model.
// No database and no Cloudflare runtime are involved.

// ---------------------------------------------------------------------------
// 1. Tool graph — proves host tool injection + ref resolution (no LLM).
// ---------------------------------------------------------------------------

describe('eval harness — tool graph', () => {
  type ToolDeps = { subject: string }

  const toolRegistry: ToolRegistry<ToolDeps> = new Map([
    [
      'shout',
      {
        id: 'shout',
        name: 'Shout',
        kind: 'function',
        description: 'Uppercases its text arg.',
        build: (deps) => (args) => {
          const { text } = args as { text: string }
          // `deps.subject` proves the host-built TDeps reached the tool.
          return Promise.resolve({
            shouted: text.toUpperCase(),
            subject: deps.subject,
          })
        },
      },
    ],
  ])

  const config: WfSdkConfig<ToolDeps> = {
    getModel: () => {
      throw new Error('no model needed for a tool-only graph')
    },
    listModels: () => [],
    listProviders: () => [],
    toolRegistry,
    triggers: {
      echo: {
        description: 'Echo',
        inputSchema: z.object({ message: z.string() }),
      },
    },
    buildRunDeps: (ctx) => ({ subject: ctx.subjectId ?? '' }),
  }

  const graph = {
    version: 1,
    nodes: [
      {
        id: 't',
        kind: 'trigger',
        label: 'Echo',
        position: { x: 0, y: 0 },
        config: { triggerKind: 'echo' },
      },
      {
        id: 'tool1',
        kind: 'tool',
        label: 'Shout',
        position: { x: 200, y: 0 },
        config: {
          toolId: 'shout',
          args: { text: { kind: 'ref', nodeId: 't', path: 'message' } },
        },
      },
      {
        id: 'o',
        kind: 'output',
        label: 'Out',
        position: { x: 400, y: 0 },
        config: {},
      },
    ],
    edges: [
      { id: 'e1', source: 't', target: 'tool1', condition: null },
      { id: 'e2', source: 'tool1', target: 'o', condition: null },
    ],
  }

  test('runs trigger → tool → output with injected deps', async () => {
    const run = await runWorkflowUnderConditions({
      name: 'tool graph',
      graph,
      triggerInput: { message: 'hello' },
      config,
      runContext: { subjectId: 'acme' },
    })

    expect(run.output).toEqual({ shouted: 'HELLO', subject: 'acme' })
    expect(run.outputNodeId).toBe('o')
    expect(run.steps.map((s) => s.nodeKind)).toEqual([
      'trigger',
      'tool',
      'output',
    ])
    expect(run.steps.every((s) => s.status === 'completed')).toBe(true)
  })

  test('rejects trigger input that fails the schema', async () => {
    await expect(
      runWorkflowUnderConditions({
        name: 'bad input',
        graph,
        triggerInput: { message: 123 },
        config,
      }),
    ).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 2. Agent graph — proves host model injection via a mock model.
// ---------------------------------------------------------------------------

describe('eval harness — agent graph', () => {
  const config: WfSdkConfig<unknown> = {
    getModel: () =>
      new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: 'text', text: 'Hello there' }],
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          warnings: [],
        }),
      }),
    listModels: () => [{ id: 'mock', label: 'Mock', providerId: 'mock' }],
    listProviders: () => [{ id: 'mock', label: 'Mock', kind: 'custom' }],
    toolRegistry: new Map(),
    triggers: {
      chat: {
        description: 'Chat',
        inputSchema: z.object({ messages: z.array(z.unknown()).min(1) }),
      },
    },
    buildRunDeps: () => ({}),
  }

  const graph = {
    version: 1,
    nodes: [
      {
        id: 't',
        kind: 'trigger',
        label: 'Chat',
        position: { x: 0, y: 0 },
        config: { triggerKind: 'chat' },
      },
      {
        id: 'a',
        kind: 'agent',
        label: 'Assistant',
        position: { x: 200, y: 0 },
        config: { agentId: 'assistant' },
      },
      {
        id: 'o',
        kind: 'output',
        label: 'Out',
        position: { x: 400, y: 0 },
        config: {},
      },
    ],
    edges: [
      { id: 'e1', source: 't', target: 'a', condition: null },
      { id: 'e2', source: 'a', target: 'o', condition: null },
    ],
  }

  test('runs trigger → agent → output using the injected model', async () => {
    const run = await runWorkflowUnderConditions({
      name: 'agent graph',
      graph,
      triggerInput: {
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      },
      config,
      manifest: [
        {
          kind: 'agent',
          id: 'assistant',
          versionId: 'v1',
          versionNumber: 1,
          name: 'Assistant',
          config: {
            modelId: 'mock',
            prompt: 'Be helpful.',
            toolIds: [],
            maxTurns: 5,
            exposeThinking: true,
            output: { kind: 'text' },
          },
        },
      ],
    })

    expect(run.output).toEqual({ text: 'Hello there' })
    expect(run.steps.map((s) => s.nodeKind)).toEqual([
      'trigger',
      'agent',
      'output',
    ])
    // stream:true forwards step text to the progress sink.
    expect(run.progress).toContainEqual({
      channel: 'progress',
      text: 'Hello there',
    })
  })
})

// ---------------------------------------------------------------------------
// 3. Blob-ref spill — proves a large value returned as a pointer is rehydrated
//    transparently inside the consuming node's step (both tool + agent inputs),
//    with graph bindings pointing at the same `text` field regardless.
// ---------------------------------------------------------------------------

describe('eval harness — blob-ref rehydration', () => {
  type Deps = { store: Map<string, string> }

  // Emulates `extract_text` spilling a large extraction: it writes the text to
  // the store and returns a pointer instead of the inline string.
  const SPILLED_TEXT = 'the full extracted document text'.repeat(50)

  const toolRegistry: ToolRegistry<Deps> = new Map([
    [
      'extract',
      {
        id: 'extract',
        name: 'Extract',
        kind: 'function',
        description: 'Returns a blob-ref pointer to spilled text.',
        build: (deps) => (args) => {
          const { key } = args as { key: string }
          deps.store.set(key, SPILLED_TEXT)
          return Promise.resolve({
            text: makeBlobRef({
              key,
              bytes: SPILLED_TEXT.length,
              preview: SPILLED_TEXT.slice(0, 8),
              storage: 'mem',
            }),
            mode: 'markdown',
          })
        },
      },
    ],
    [
      // A downstream function tool that receives the pointer via a ref binding —
      // proves tool-node args are rehydrated before the tool sees them.
      'measure',
      {
        id: 'measure',
        name: 'Measure',
        kind: 'function',
        description: 'Returns the length of its (rehydrated) text arg.',
        inputSchema: z.object({ text: z.string() }),
        build: () => (args) => {
          const { text } = args as { text: string }
          return Promise.resolve({ length: text.length })
        },
      },
    ],
  ])

  const config: WfSdkConfig<Deps> = {
    getModel: () =>
      new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        }),
      }),
    listModels: () => [{ id: 'mock', label: 'Mock', providerId: 'mock' }],
    listProviders: () => [{ id: 'mock', label: 'Mock', kind: 'custom' }],
    toolRegistry,
    triggers: {
      go: { description: 'Go', inputSchema: z.object({ key: z.string() }) },
    },
    buildRunDeps: () => ({ store: new Map<string, string>() }),
    // The store is per-run; but buildRunDeps is called once here, so the same
    // Map instance both stores (in extract) and reads (in the resolver).
    resolveBlobRef: (ref, deps) => {
      const text = deps.store.get(ref.key)
      if (text === undefined) throw new Error(`missing blob ${ref.key}`)
      return Promise.resolve(text)
    },
  }

  const graph = {
    version: 1,
    nodes: [
      {
        id: 't',
        kind: 'trigger',
        label: 'Go',
        position: { x: 0, y: 0 },
        config: { triggerKind: 'go' },
      },
      {
        id: 'extract',
        kind: 'tool',
        label: 'Extract',
        position: { x: 200, y: 0 },
        config: {
          toolId: 'extract',
          args: { key: { kind: 'ref', nodeId: 't', path: 'key' } },
        },
      },
      {
        id: 'summarize',
        kind: 'agent',
        label: 'Summarize',
        position: { x: 400, y: 0 },
        // Binds the pointer field exactly as it would a plain string.
        config: {
          agentId: 'summarizer',
          inputs: { text: { kind: 'ref', nodeId: 'extract', path: 'text' } },
        },
      },
      {
        id: 'measure',
        kind: 'tool',
        label: 'Measure',
        position: { x: 600, y: 0 },
        config: {
          toolId: 'measure',
          args: { text: { kind: 'ref', nodeId: 'extract', path: 'text' } },
        },
      },
      {
        id: 'o',
        kind: 'output',
        label: 'Out',
        position: { x: 800, y: 0 },
        config: {},
      },
    ],
    edges: [
      { id: 'e1', source: 't', target: 'extract', condition: null },
      { id: 'e2', source: 'extract', target: 'summarize', condition: null },
      { id: 'e3', source: 'summarize', target: 'measure', condition: null },
      { id: 'e4', source: 'measure', target: 'o', condition: null },
    ],
  }

  const manifest = [
    {
      kind: 'agent' as const,
      id: 'summarizer',
      versionId: 'v1',
      versionNumber: 1,
      name: 'Summarizer',
      config: {
        modelId: 'mock',
        prompt: 'Summarize this:\n${text}',
        toolIds: [],
        maxTurns: 1,
        exposeThinking: false,
        output: { kind: 'text' as const },
      },
    },
  ]

  test('rehydrates the pointer into both an agent prompt and a tool arg', async () => {
    const run = await runWorkflowUnderConditions({
      name: 'blob-ref graph',
      graph,
      triggerInput: { key: 'extracted/doc.txt' },
      config,
      manifest,
    })

    // The tool node's `text` arg was rehydrated to the full text before the
    // tool ran — measured length equals the spilled text, not the short preview.
    expect(run.output).toEqual({ length: SPILLED_TEXT.length })

    // The agent's system prompt interpolated the FULL rehydrated text, not the
    // pointer's JSON or its truncated preview.
    const agentStep = run.steps.find((s) => s.nodeId === 'summarize')
    const systemPrompt = (agentStep?.meta as { systemPrompt?: string })
      ?.systemPrompt
    expect(systemPrompt).toContain(SPILLED_TEXT)
    expect(systemPrompt).not.toContain('__wfBlobRef')

    // The spilled tool output recorded on the extract step stays a small pointer
    // — the big text never sits in the step trace.
    const extractStep = run.steps.find((s) => s.nodeId === 'extract')
    const extractOut = extractStep?.output as { text: unknown }
    expect(makeBlobRef({ key: 'x' })).toHaveProperty('__wfBlobRef')
    expect(extractOut.text).toHaveProperty('__wfBlobRef', true)
  })
})
