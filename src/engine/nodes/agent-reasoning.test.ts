import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, test } from 'bun:test'

import { makeAgentConfig } from '../agent-test-helpers'
import type { AgentNode, WfRunManifestEntry } from '../graph'
import { mockFinish, mockUsage } from '../model-test-helpers'

import { executeAgentNode } from './agent'

// `reasoning` decides whether the model gets an extra thinking pass before it
// answers — seconds on a short task, minutes on a long one (the ingest
// structurer averaged 127s with a 17-minute tail on an implicit provider
// default).
//
// The whole point of these tests is that the field is WIRED. An earlier
// `enableReasoning` was deleted precisely because nothing passed it: it sat in
// the config and in run dumps reading like a live switch while changing
// nothing. A field that silently does nothing is worse than no field, so what
// is pinned here is the intent reaching `getModel` — not any provider
// behaviour, which is the host's business.

const NODE: AgentNode = {
  id: 'agent',
  kind: 'agent',
  label: 'Bot',
  position: { x: 0, y: 0 },
  // 'off' deliberately: the node's own inform-user reasoning toggle is about
  // DISPLAY. It must not influence what is asked of the model.
  informUser: { mode: 'off' },
  config: { agentId: 'bot', version: null, inputs: {} },
}

function manifest(reasoning: boolean): WfRunManifestEntry[] {
  return [
    {
      kind: 'agent',
      id: 'bot',
      pinnedVersion: null,
      versionId: 'v1',
      versionNumber: 1,
      name: 'Bot',
      config: makeAgentConfig({
        modelId: 'mock',
        prompt: 'Answer.',
        userPrompt: 'Go.',
        inputKind: 'task' as const,
        toolIds: [],
        maxTurns: 1,
        reasoning,
        output: { kind: 'text' },
      }),
    },
  ]
}

function model () {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: 'Answer.' }],
      finishReason: mockFinish('stop'),
      usage: mockUsage(1, 1),
      warnings: [],
    }),
  })
}

/** Capture the reasoning intent the node hands the host's model factory. */
function runCapturing(
  entries: WfRunManifestEntry[],
  agentOverride?: { reasoning?: boolean },
) {
  const seen: Array<boolean | undefined> = []
  const done = executeAgentNode<unknown>({
    node: NODE,
    getModel: (_modelId, opts) => {
      seen.push(opts?.reasoning)
      return model()
    },
    toolRegistry: new Map(),
    toolDeps: {},
    promptVariables: {},
    nodeOutputs: new Map(),
    manifest: entries,
    ...(agentOverride ? { agentOverride } : {}),
  })
  return { seen, done }
}

describe('agent reasoning setting', () => {
  test('an agent with reasoning off asks for no thinking pass', async () => {
    const { seen, done } = runCapturing(manifest(false))
    await done
    // Explicitly `false`, never undefined. Undefined means "no intent, take the
    // provider default" — and for Venice that default is thinking ON, which is
    // the implicit behaviour this setting exists to stop.
    expect(seen).toEqual([false])
  })

  test('an agent with reasoning on asks for it', async () => {
    const { seen, done } = runCapturing(manifest(true))
    await done
    expect(seen).toEqual([true])
  })

  test('the eval override wins over the saved setting', async () => {
    // So one eval can run the same agent both ways and measure what the extra
    // pass actually buys.
    const { seen, done } = runCapturing(manifest(false), { reasoning: true })
    await done
    expect(seen).toEqual([true])
  })

  test('the display toggle does not change what is asked of the model', async () => {
    // Streaming the thinking to the user is a per-placement display choice; it
    // must never turn the thinking itself on or off. Same agent, same intent,
    // with the node's reasoning stream enabled.
    const seen: Array<boolean | undefined> = []
    await executeAgentNode<unknown>({
      node: {
        ...NODE,
        informUser: { mode: 'dynamic', reasoning: true, tools: false },
      },
      getModel: (_modelId, opts) => {
        seen.push(opts?.reasoning)
        return model()
      },
      toolRegistry: new Map(),
      toolDeps: {},
      promptVariables: {},
      nodeOutputs: new Map(),
      manifest: manifest(false),
    })
    expect(seen).toEqual([false])
  })
})
