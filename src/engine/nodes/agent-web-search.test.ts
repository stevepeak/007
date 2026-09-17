import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, test } from 'bun:test'

import { makeAgentConfig } from '../agent-test-helpers'
import type { AgentNode, WebSearchMode, WfRunManifestEntry } from '../graph'
import { mockFinish, mockUsage } from '../model-test-helpers'

import { executeAgentNode } from './agent'

// `webSearch` opens a network path the host cannot screen: the provider writes
// the search query from the full conversation and sends it out before the
// model answers. So two things are pinned here, and neither is provider
// behaviour (that is the host's business):
//
//   • the agent's OWN setting reaches `getModel`, explicitly, on every call —
//     a field that sits in the config and changes nothing is worse than no
//     field (see the `enableReasoning` history in `agent-reasoning.test.ts`);
//   • nothing but that setting can turn it on. The eval override and the
//     node's display toggles have no say, so an author who left it off can
//     trust that it is off.

const NODE: AgentNode = {
  id: 'agent',
  kind: 'agent',
  label: 'Bot',
  position: { x: 0, y: 0 },
  informUser: { mode: 'off' },
  config: { agentId: 'bot', version: null, inputs: {} },
}

function manifest(
  webSearch: WebSearchMode,
  webCitations = false,
): WfRunManifestEntry[] {
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
        webSearch,
        webCitations,
        output: { kind: 'text' },
      }),
    },
  ]
}

function model() {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: 'Answer.' }],
      finishReason: mockFinish('stop'),
      usage: mockUsage(1, 1),
      warnings: [],
    }),
  })
}

type Seen = { webSearch?: WebSearchMode; webCitations?: boolean }

async function run(
  entries: WfRunManifestEntry[],
  agentOverride?: { reasoning?: boolean },
): Promise<Seen[]> {
  const seen: Seen[] = []
  await executeAgentNode<unknown>({
    node: NODE,
    getModel: (_modelId, opts) => {
      seen.push({ webSearch: opts?.webSearch, webCitations: opts?.webCitations })
      return model()
    },
    toolRegistry: new Map(),
    toolDeps: {},
    promptVariables: {},
    nodeOutputs: new Map(),
    manifest: entries,
    ...(agentOverride ? { agentOverride } : {}),
  })
  return seen
}

describe('agent web search setting', () => {
  test('off is passed explicitly, never left undefined', async () => {
    // Explicit so the host can tell "the agent said off" from "nobody said
    // anything" — the latter is what a host-side default could creep into.
    expect(await run(manifest('off'))).toEqual([
      { webSearch: 'off', webCitations: false },
    ])
  })

  test('the agent setting reaches the model factory as-is', async () => {
    expect(await run(manifest('auto'))).toEqual([
      { webSearch: 'auto', webCitations: false },
    ])
    expect(await run(manifest('on', true))).toEqual([
      { webSearch: 'on', webCitations: true },
    ])
  })

  test('the eval override cannot turn it on', async () => {
    // The override exists to compare reasoning on/off; it carries no web-search
    // knob at all, so an eval can never open a network path the author left
    // closed.
    expect(await run(manifest('off'), { reasoning: true })).toEqual([
      { webSearch: 'off', webCitations: false },
    ])
  })

  test('a stored config without the field parses as off', () => {
    // Configs published before the field existed carry no `webSearch`; the
    // schema default must be off, not undefined, for the same reason as above.
    expect(makeAgentConfig({})).toMatchObject({
      webSearch: 'off',
      webCitations: false,
    })
  })
})
