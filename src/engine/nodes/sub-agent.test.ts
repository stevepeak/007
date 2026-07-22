import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, test } from 'bun:test'

import type { AgentConfig, SubAgentsConfig, WfRunManifestEntry } from '../graph'
import { createMemoryRunRecorder } from '../run-recorder'
import type { RunNodeContext } from '../run-node'
import type { ToolRegistry } from '../tool-registry'

import type { JoinResult } from './spawn-manager'
import { synthesizeDelegationTools } from './sub-agent'

// End-to-end delegation through the real engine wiring: the synthesized
// spawn/await tools resolve their targets from the run manifest, run each
// sub-agent inline via the shared generation core, record a child run-step under
// the primary node, and — the key affordance — short-circuit the join on a stop
// signal. We drive the tools directly (rather than scripting the primary's tool
// loop) so the test is deterministic; the sub-agents run through the genuine
// `runAgentGeneration` path against a mock model.

const baseConfig = (over: Partial<AgentConfig>): AgentConfig => ({
  modelId: 'mock',
  prompt: '',
  toolIds: [],
  maxTurns: 3,
  exposeThinking: false,
  output: { kind: 'text' },
  subAgents: {
    targets: [],
    maxConcurrent: 4,
    maxSpawns: 10,
    allowStopSignal: true,
  },
  ...over,
})

function agentEntry(
  id: string,
  name: string,
  config: AgentConfig,
): WfRunManifestEntry {
  return {
    kind: 'agent',
    id,
    pinnedVersion: null,
    versionId: `${id}-v1`,
    versionNumber: 1,
    name,
    config,
  }
}

// The primary whitelists two sub-agents; the join tool + spawn_* tools are keyed
// off these display names (→ spawn_researcher / spawn_critic).
const PRIMARY_SUBAGENTS: SubAgentsConfig = {
  targets: [
    { kind: 'agent', id: 'researcher', version: null },
    { kind: 'agent', id: 'critic', version: null },
  ],
  maxConcurrent: 2,
  maxSpawns: 10,
  allowStopSignal: true,
}

function systemMarker(options: unknown): string {
  const prompt = (options as { prompt?: Array<{ role: string; content: unknown }> })
    .prompt
  const sys = prompt?.find((m) => m.role === 'system')
  return typeof sys?.content === 'string'
    ? sys.content
    : JSON.stringify(sys?.content ?? '')
}

function makeCtx(
  getModel: RunNodeContext<unknown>['getModel'],
  manifest: WfRunManifestEntry[],
) {
  const recorder = createMemoryRunRecorder()
  const ctx: RunNodeContext<unknown> = {
    getModel,
    toolRegistry: new Map() as ToolRegistry<unknown>,
    toolDeps: {},
    nodeOutputs: new Map(),
    manifest,
    promptVariables: {},
    subStepRecorder: recorder,
  }
  return { ctx, recorder }
}

// Invoke a synthesized tool's execute the way the AI SDK would.
async function call(tool: unknown, args: unknown): Promise<unknown> {
  const execute = (tool as { execute: (a: unknown, o: unknown) => unknown })
    .execute
  return execute(args, { toolCallId: 'call', messages: [] })
}

const textModel = (marker: string, text: string) =>
  new MockLanguageModelV3({
    doGenerate: async (options) => {
      if (!systemMarker(options).includes(marker)) {
        return {
          content: [{ type: 'text' as const, text: 'unexpected' }],
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        }
      }
      return {
        content: [{ type: 'text' as const, text }],
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      }
    },
  })

describe('sub-agent delegation — end to end', () => {
  test('join collects every sub-agent result and records child steps', async () => {
    const manifest = [
      agentEntry('p', 'Primary', baseConfig({ subAgents: PRIMARY_SUBAGENTS })),
      agentEntry(
        'researcher',
        'Researcher',
        baseConfig({ prompt: 'RESEARCH the topic.' }),
      ),
      agentEntry('critic', 'Critic', baseConfig({ prompt: 'CRITIC review.' })),
    ]
    // One model instance per getModel call; branch on the system prompt marker.
    const getModel = () =>
      new MockLanguageModelV3({
        doGenerate: async (options) => {
          const m = systemMarker(options)
          const text = m.includes('RESEARCH') ? 'finding 42' : 'looks fine'
          return {
            content: [{ type: 'text' as const, text }],
            finishReason: 'stop' as const,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            warnings: [],
          }
        },
      })
    const { ctx, recorder } = makeCtx(getModel, manifest)
    const tools = synthesizeDelegationTools(PRIMARY_SUBAGENTS, {
      ctx,
      primaryNodeId: 'p',
    })

    await call(tools.spawn_researcher, { message: 'research topic' })
    await call(tools.spawn_critic, { message: 'critique it' })
    const res = (await call(tools.await_subagents, {})) as JoinResult

    expect(res.stopped).toBe(false)
    expect(res.pending).toHaveLength(0)
    const outs = res.completed.map((c) => c.output)
    expect(outs).toContainEqual({ text: 'finding 42' })
    expect(outs).toContainEqual({ text: 'looks fine' })

    // Each sub-agent recorded a child step scoped to the primary node.
    const children = recorder.steps.filter((s) => s.parentNodeId === 'p')
    expect(children).toHaveLength(2)
    expect(children.every((s) => s.nodeKind === 'agent')).toBe(true)
    expect(children.map((s) => s.itemIndex).sort()).toEqual([0, 1])
  })

  test('a sub-agent stop signal short-circuits the join', async () => {
    // The critic is an object-output agent that returns the reserved `__stop`
    // field; the researcher hangs forever, so it stays pending when the join
    // short-circuits.
    const criticOutput = {
      kind: 'object' as const,
      source: '',
      schema: {
        type: 'object',
        properties: {
          __stop: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: ['__stop', 'reason'],
        additionalProperties: false,
      },
    }
    const manifest = [
      agentEntry('p', 'Primary', baseConfig({ subAgents: PRIMARY_SUBAGENTS })),
      agentEntry(
        'researcher',
        'Researcher',
        baseConfig({ prompt: 'RESEARCH forever.' }),
      ),
      agentEntry(
        'critic',
        'Critic',
        baseConfig({ prompt: 'CRITIC decisively.', output: criticOutput }),
      ),
    ]
    const getModel = () =>
      new MockLanguageModelV3({
        doGenerate: async (options) => {
          const m = systemMarker(options)
          if (m.includes('RESEARCH')) {
            // Never resolves → this sub-agent stays running.
            return new Promise(() => {})
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ __stop: true, reason: 'critical' }),
              },
            ],
            finishReason: 'stop' as const,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            warnings: [],
          }
        },
      })
    const { ctx, recorder } = makeCtx(getModel, manifest)
    const tools = synthesizeDelegationTools(PRIMARY_SUBAGENTS, {
      ctx,
      primaryNodeId: 'p',
    })

    await call(tools.spawn_researcher, { message: 'dig' }) // spawn-0, hangs
    await call(tools.spawn_critic, { message: 'judge' }) // spawn-1, stops
    const res = (await call(tools.await_subagents, {})) as JoinResult

    expect(res.stopped).toBe(true)
    const critic = res.completed.find((c) => c.spawnId === 'spawn-1')
    expect(critic?.stopSignalled).toBe(true)
    expect(critic?.reason).toBe('critical')
    expect(res.pending.map((p) => p.spawnId)).toEqual(['spawn-0'])

    // Only the settled critic recorded a child step.
    const children = recorder.steps.filter((s) => s.parentNodeId === 'p')
    expect(children).toHaveLength(1)
    expect(children[0]?.itemIndex).toBe(1)
  })
})
