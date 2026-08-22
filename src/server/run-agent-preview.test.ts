import { tool } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import { makeAgentConfig } from '../engine/agent-test-helpers'
import type { RunContext, WfSdkConfig } from '../engine/config'
import type { AgentConfig } from '../engine/graph'
import { mockFinish, mockUsage } from '../engine/model-test-helpers'
import type { ToolRegistry } from '../engine/tool-registry'

import { executeAgentPreview } from './run-agent-preview'

// The two things the playground promises that aren't visible in its output:
// which history the model actually saw, and which tools were real.

type Deps = { marker: string }

const BASE_CONFIG: AgentConfig = makeAgentConfig({
  modelId: 'mock',
  prompt: 'Answer.',
  userPrompt: 'Go.',
  inputKind: 'task' as const,
  toolIds: [],
  maxTurns: 1,
  output: { kind: 'text' },
})

// The playground runs the agent's REAL contract, so a conversation preview needs
// an agent that declares one — a task agent ignores authored turns entirely.
const CHAT_CONFIG: AgentConfig = {
  ...BASE_CONFIG,
  inputKind: 'conversation',
  userPrompt: '',
}

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
  onBuildDeps?: (ctx: RunContext) => void
}): WfSdkConfig<Deps> {
  return {
    getModel: () =>
      new MockLanguageModelV3({
        doGenerate: async (o) => {
          opts.seen.prompt = (o as { prompt: unknown }).prompt
          return {
            content: [{ type: 'text', text: 'ok' }],
            finishReason: mockFinish('stop'),
            usage: mockUsage(1, 1),
            warnings: [],
          }
        },
      }),
    toolRegistry: opts.registry ?? new Map(),
    buildRunDeps: (ctx: RunContext) => {
      opts.onBuildDeps?.(ctx)
      return { marker: 'real' }
    },
  } as unknown as WfSdkConfig<Deps>
}

describe('executeAgentPreview — conversation', () => {
  test('authored turns become the history, with the input as the newest turn', async () => {
    const seen: { prompt: unknown } = { prompt: null }
    await executeAgentPreview({
      config: CHAT_CONFIG,
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
      config: CHAT_CONFIG,
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

  test('the run scope reaches the deps a live tool is built from', async () => {
    // The whole context feature rides on this pass-through: whatever the host
    // maps out of the playground's Context form has to arrive here, or a live
    // tool filters on nothing and reports a confidently empty result.
    const seen: { prompt: unknown } = { prompt: null }
    const built = { live: null as unknown, simulated: false }
    let depsCtx: RunContext | null = null
    await executeAgentPreview({
      config: { ...BASE_CONFIG, toolIds: ['live_tool'] },
      input: 'go',
      liveToolIds: ['live_tool'],
      wfConfig: fakeConfig({
        seen,
        registry: registry(built),
        onBuildDeps: (ctx) => {
          depsCtx = ctx
        },
      }),
      runContext: {
        triggerKind: 'playground',
        correlationId: 'org-1',
        subjectId: 'chat-1',
      },
    })

    expect(depsCtx).toMatchObject({
      correlationId: 'org-1',
      subjectId: 'chat-1',
    })
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

describe('executeAgentPreview — a live tool actually executes', () => {
  // Building the tool against real deps (above) is necessary but not sufficient:
  // what an author is promised is that the RESULT the agent reasoned on came
  // from the real implementation. So drive a full tool-calling turn and read the
  // outputs back off the trace.
  const CALLING_CONFIG: AgentConfig = {
    ...BASE_CONFIG,
    toolIds: ['live_tool', 'fake_tool'],
    maxTurns: 2,
  }

  function callingModel() {
    let toolTurn = 0
    return new MockLanguageModelV3({
      doGenerate: async (o) => {
        // The simulator stands in for a tool with a plain, tool-less generation;
        // the agent loop itself always passes the tool set. That's what tells
        // the two callers of this one mock apart.
        const hasTools = ((o as { tools?: unknown[] }).tools ?? []).length > 0
        if (hasTools && toolTurn++ === 0) {
          return {
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'c1',
                toolName: 'live_tool',
                input: '{}',
              },
              {
                type: 'tool-call' as const,
                toolCallId: 'c2',
                toolName: 'fake_tool',
                input: '{}',
              },
            ],
            finishReason: mockFinish('tool-calls'),
            usage: mockUsage(1, 1),
            warnings: [],
          }
        }
        return {
          content: [
            { type: 'text' as const, text: hasTools ? 'done' : 'invented' },
          ],
          finishReason: mockFinish('stop'),
          usage: mockUsage(1, 1),
          warnings: [],
        }
      },
    })
  }

  function callingRegistry(ran: { live: boolean; fake: boolean }) {
    const entry = (id: string, mark: () => void) => ({
      id,
      name: id,
      description: id,
      kind: 'ai-tool' as const,
      inputSchema: z.object({}),
      build: () =>
        tool({
          inputSchema: z.object({}),
          execute: async () => {
            mark()
            return { source: 'real', tool: id }
          },
        }),
    })
    return new Map([
      [
        'live_tool',
        entry('live_tool', () => {
          ran.live = true
        }),
      ],
      [
        'fake_tool',
        entry('fake_tool', () => {
          ran.fake = true
        }),
      ],
    ]) as ToolRegistry<Deps>
  }

  test('the live tool runs for real and its result is what the agent sees', async () => {
    const ran = { live: false, fake: false }
    const model = callingModel()
    const result = await executeAgentPreview({
      config: CALLING_CONFIG,
      input: 'go',
      liveToolIds: ['live_tool'],
      wfConfig: {
        getModel: () => model,
        toolRegistry: callingRegistry(ran),
        buildRunDeps: () => ({ marker: 'real' }),
      } as unknown as WfSdkConfig<Deps>,
      runContext: { triggerKind: 'playground' },
    })

    expect(ran.live).toBe(true)
    // The whole point of the simulated mode: this implementation never ran.
    expect(ran.fake).toBe(false)

    const calls = result.meta.steps.flatMap((s) => s.toolCalls)
    const byName = (name: string) => calls.find((c) => c.toolName === name)
    expect(byName('live_tool')?.output).toEqual({
      source: 'real',
      tool: 'live_tool',
    })
    // Simulated: the model's invention, in the simulator's envelope.
    expect(byName('fake_tool')?.output).toEqual({ result: 'invented' })
  })
})
