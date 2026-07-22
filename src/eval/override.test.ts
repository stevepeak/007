import { describe, expect, test } from 'bun:test'
import { MockLanguageModelV3 } from 'ai/test'
import { z } from 'zod'

import type { AgentNodeMeta } from '../engine/nodes/agent'
import type { WfSdkConfig } from '../engine'
import { runWorkflowUnderConditions } from './index'

// Matrix eval override — proves `runContext.agentOverride` swaps the agent
// node's model and system prompt at run time (the seam the model×prompt matrix
// runner drives), and that the recorded `AgentNodeMeta.model` reflects the
// OVERRIDE model (not the manifest's saved model) so run cost prices correctly.

describe('agent override — matrix eval seam', () => {
  // Records which modelId `getModel` was asked for, so the test can assert the
  // override id — not the agent's saved `mock` — reached the model factory.
  function makeConfig(seen: string[]): WfSdkConfig<unknown> {
    return {
      getModel: (modelId) => {
        seen.push(modelId)
        return new MockLanguageModelV3({
          doGenerate: async () => ({
            content: [{ type: 'text', text: 'ok' }],
            finishReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            warnings: [],
          }),
        })
      },
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

  const manifest = [
    {
      kind: 'agent' as const,
      id: 'assistant',
      versionId: 'v1',
      versionNumber: 1,
      name: 'Assistant',
      config: {
        modelId: 'mock',
        prompt: 'Saved prompt.',
        toolIds: [],
        maxTurns: 5,
        exposeThinking: true,
        output: { kind: 'text' as const },
      },
    },
  ]

  const triggerInput = {
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
  }

  test('override swaps model + prompt; meta records the override model', async () => {
    const seen: string[] = []
    const run = await runWorkflowUnderConditions({
      name: 'override',
      graph,
      triggerInput,
      config: makeConfig(seen),
      manifest,
      runContext: {
        agentOverride: { modelId: 'override-model', prompt: 'Overridden prompt.' },
      },
    })

    expect(seen).toEqual(['override-model'])
    const agentStep = run.steps.find((s) => s.nodeKind === 'agent')
    const meta = agentStep?.meta as AgentNodeMeta
    expect(meta.model).toBe('override-model')
    expect(meta.systemPrompt).toBe('Overridden prompt.')
  })

  test('no override falls through to the agent’s saved model + prompt', async () => {
    const seen: string[] = []
    const run = await runWorkflowUnderConditions({
      name: 'baseline',
      graph,
      triggerInput,
      config: makeConfig(seen),
      manifest,
    })

    expect(seen).toEqual(['mock'])
    const meta = run.steps.find((s) => s.nodeKind === 'agent')?.meta as AgentNodeMeta
    expect(meta.model).toBe('mock')
    expect(meta.systemPrompt).toBe('Saved prompt.')
  })

  test('a partial override (prompt only) keeps the saved model', async () => {
    const seen: string[] = []
    const run = await runWorkflowUnderConditions({
      name: 'prompt-only',
      graph,
      triggerInput,
      config: makeConfig(seen),
      manifest,
      runContext: { agentOverride: { prompt: 'Only the prompt changed.' } },
    })

    expect(seen).toEqual(['mock'])
    const meta = run.steps.find((s) => s.nodeKind === 'agent')?.meta as AgentNodeMeta
    expect(meta.model).toBe('mock')
    expect(meta.systemPrompt).toBe('Only the prompt changed.')
  })
})
