import { tool } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import type { WfSdkConfig } from '../engine/config'
import type { AgentConfig } from '../engine/graph'
import type { ToolRegistry } from '../engine/tool-registry'

import { executeAgentPreview } from './run-agent-preview'

// The two things the playground promises that aren't visible in its output:
// which history the model actually saw, and which tools were real.

type Deps = { marker: string }

const BASE_CONFIG: AgentConfig = {
  modelId: 'mock',
  prompt: 'Answer.',
  toolIds: [],
  maxTurns: 1,
  output: { kind: 'text' },
} as AgentConfig

/** The role/text of every turn in the model's prompt, in order. */
function turns(prompt: unknown): string {
  const messages = Array.isArray(prompt) ? prompt : []
  return (messages as Array<{ role?: string; content?: unknown }>)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      const parts = Array.isArray(m.content) ? m.content : []
      const text = (parts as Array<Record<string, unknown>>)
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('')
      return `${m.role}:${text}`
    })
    .join(' | ')
}

function fakeConfig(opts: {
  seen: { prompt: unknown }
  registry?: ToolRegistry<Deps>
  onBuildDeps?: () => void
}): WfSdkConfig<Deps> {
  return {
    getModel: () =>
      new MockLanguageModelV3({
        doGenerate: async (o) => {
          opts.seen.prompt = (o as { prompt: unknown }).prompt
          return {
            content: [{ type: 'text', text: 'ok' }],
            finishReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            warnings: [],
          }
        },
      }),
    toolRegistry: opts.registry ?? new Map(),
    buildRunDeps: () => {
      opts.onBuildDeps?.()
      return { marker: 'real' }
    },
  } as unknown as WfSdkConfig<Deps>
}

describe('executeAgentPreview — conversation', () => {
  test('authored turns become the history, with the input as the newest turn', async () => {
    const seen: { prompt: unknown } = { prompt: null }
    await executeAgentPreview({
      config: BASE_CONFIG,
      input: 'and the second one?',
      messages: [
        { role: 'user', text: 'I have two leases' },
        { role: 'assistant', text: 'Tell me about the first' },
      ],
      wfConfig: fakeConfig({ seen }),
      runContext: { triggerKind: 'playground' },
    })

    expect(turns(seen.prompt)).toBe(
      'user:I have two leases | assistant:Tell me about the first | user:and the second one?',
    )
  })

  test('no authored turns leaves the agent answering the input alone', async () => {
    const seen: { prompt: unknown } = { prompt: null }
    await executeAgentPreview({
      config: BASE_CONFIG,
      input: 'hello',
      wfConfig: fakeConfig({ seen }),
      runContext: { triggerKind: 'playground' },
    })

    expect(turns(seen.prompt)).toBe('user:hello')
  })
})

describe('executeAgentPreview — live vs simulated tools', () => {
  function registry(built: { live: unknown; simulated: boolean }) {
    const entry = (id: string, isLive: boolean) => ({
      id,
      name: id,
      description: id,
      kind: 'ai-tool' as const,
      inputSchema: z.object({}),
      build: (deps: Deps) => {
        // Reaching a real `build` IS the live path: it's the only way a tool
        // gets the host's deps, and the only way it can touch anything.
        if (isLive) built.live = deps
        else built.simulated = true
        return tool({ inputSchema: z.object({}), execute: async () => ({}) })
      },
    })
    return new Map([
      ['live_tool', entry('live_tool', true)],
      ['fake_tool', entry('fake_tool', false)],
    ]) as ToolRegistry<Deps>
  }

  test('only the opted-in tool is built against the real deps', async () => {
    const seen: { prompt: unknown } = { prompt: null }
    const built = { live: null as unknown, simulated: false }
    let depsBuilt = 0
    await executeAgentPreview({
      config: { ...BASE_CONFIG, toolIds: ['live_tool', 'fake_tool'] },
      input: 'go',
      liveToolIds: ['live_tool'],
      wfConfig: fakeConfig({
        seen,
        registry: registry(built),
        onBuildDeps: () => depsBuilt++,
      }),
      runContext: { triggerKind: 'playground' },
    })

    expect(built.live).toEqual({ marker: 'real' })
    expect(built.simulated).toBe(false)
    expect(depsBuilt).toBe(1)
  })

  test('an all-simulated run never builds the host deps', async () => {
    const seen: { prompt: unknown } = { prompt: null }
    const built = { live: null as unknown, simulated: false }
    let depsBuilt = 0
    await executeAgentPreview({
      config: { ...BASE_CONFIG, toolIds: ['live_tool', 'fake_tool'] },
      input: 'go',
      wfConfig: fakeConfig({
        seen,
        registry: registry(built),
        onBuildDeps: () => depsBuilt++,
      }),
      runContext: { triggerKind: 'playground' },
    })

    expect(depsBuilt).toBe(0)
    expect(built.live).toBeNull()
    expect(built.simulated).toBe(false)
  })
})
