import { describe, expect, test } from 'bun:test'
import { MockLanguageModelV3 } from 'ai/test'
import { z } from 'zod'

import { agentConfigSchema, type WfSdkConfig } from '../engine'
import type { AgentNodeMeta } from '../engine/nodes/agent'
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
        config: { source: { kind: 'ref', nodeId: 'a', path: '' } },
      },
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
        userPrompt: 'Go.',
        inputKind: 'task' as const,
        toolIds: [],
        maxTurns: 5,
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
        agentOverride: {
          modelId: 'override-model',
          prompt: 'Overridden prompt.',
        },
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
    const meta = run.steps.find((s) => s.nodeKind === 'agent')
      ?.meta as AgentNodeMeta
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
    const meta = run.steps.find((s) => s.nodeKind === 'agent')
      ?.meta as AgentNodeMeta
    expect(meta.model).toBe('mock')
    expect(meta.systemPrompt).toBe('Only the prompt changed.')
  })

  // The DRAFT seam: the agent editor runs its goals against unsaved edits by
  // shipping the whole config with the run, not just the prompt. What makes this
  // more than `prompt` twice over is everything else in the config — here, the
  // user turn — which no other override can reach.
  const draft = agentConfigSchema.parse({
    modelId: 'draft-model',
    prompt: 'Draft prompt.',
    userPrompt: 'Draft turn.',
    maxTurns: 9,
  })

  test('a config override replaces the whole saved config, not just the prompt', async () => {
    const seen: string[] = []
    const run = await runWorkflowUnderConditions({
      name: 'draft',
      graph,
      triggerInput,
      config: makeConfig(seen),
      manifest,
      runContext: { agentOverride: { config: draft } },
    })

    expect(seen).toEqual(['draft-model'])
    const step = run.steps.find((s) => s.nodeKind === 'agent')
    const meta = step?.meta as AgentNodeMeta
    expect(meta.model).toBe('draft-model')
    expect(meta.systemPrompt).toBe('Draft prompt.')
    // The saved version is still what the node POINTS at, so the step stays
    // traceable back to the agent it was drafted from.
    expect(meta.agentVersion).toBe(1)
  })

  test('matrix axes layer on top of the draft config', async () => {
    const seen: string[] = []
    const run = await runWorkflowUnderConditions({
      name: 'draft-matrix',
      graph,
      triggerInput,
      config: makeConfig(seen),
      manifest,
      runContext: {
        agentOverride: {
          config: draft,
          modelId: 'sweep-model',
          prompt: 'Sweep prompt.',
        },
      },
    })

    expect(seen).toEqual(['sweep-model'])
    const meta = run.steps.find((s) => s.nodeKind === 'agent')
      ?.meta as AgentNodeMeta
    expect(meta.model).toBe('sweep-model')
    expect(meta.systemPrompt).toBe('Sweep prompt.')
  })

  test('a draft runs against an agent with no published version at all', async () => {
    // The manifest is EMPTY — a brand-new agent has nothing to freeze. Without
    // the config override this is the "not in the run manifest" hard error, and
    // an author could never eval an agent until after publishing it once.
    const seen: string[] = []
    const run = await runWorkflowUnderConditions({
      name: 'unpublished-draft',
      graph,
      triggerInput,
      config: makeConfig(seen),
      manifest: [],
      runContext: { agentOverride: { config: draft } },
    })

    expect(seen).toEqual(['draft-model'])
    const meta = run.steps.find((s) => s.nodeKind === 'agent')
      ?.meta as AgentNodeMeta
    expect(meta.systemPrompt).toBe('Draft prompt.')
    // No version exists to stamp — and "absent" must stay distinguishable from
    // "version 0", which is why the field is optional rather than defaulted.
    expect(meta.agentVersion).toBeUndefined()
  })

  test('an empty manifest with no override is still the hard error', async () => {
    await expect(
      runWorkflowUnderConditions({
        name: 'unpublished-no-override',
        graph,
        triggerInput,
        config: makeConfig([]),
        manifest: [],
      }),
    ).rejects.toThrow(/not in the run manifest/)
  })
})
