import { tool } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import { makeAgentConfig } from '../agent-test-helpers'
import type { AgentConfig, SubAgentsConfig } from '../graph'
import { mockFinish, mockUsage } from '../model-test-helpers'
import type { RunNodeContext } from '../run-node'
import { createMemoryRunRecorder } from '../run-recorder'
import type { ToolRegistry } from '../tool-registry'

import type { JoinResult } from './spawn-manager'
import { synthesizeDelegationTools } from './sub-agent'
import { spawnInputSchema, synthesizeTargets } from './sub-agent-tools'

/**
 * A sub-agent can never hold more than its parent run: it gets the parent's
 * own tool deps (the host's per-run scope), only the tools its OWN config
 * lists, and the spawn call carries a message and prompt variables — no field
 * through which the delegating model could name a different scope.
 */
interface Deps {
  scope: string
}

const SUB_AGENTS: SubAgentsConfig = {
  targets: [{ kind: 'agent', id: 'helper', version: null }],
  maxConcurrent: 1,
  maxSpawns: 2,
  allowStopSignal: false,
}

function config(over: Partial<AgentConfig>): AgentConfig {
  return makeAgentConfig({
    modelId: 'mock',
    prompt: 'PRIMARY',
    userPrompt: 'Go.',
    inputKind: 'task' as const,
    toolIds: [],
    maxTurns: 3,
    output: { kind: 'text' },
    ...over,
  })
}

describe('sub-agents never widen their parent run', () => {
  test('a sub-agent sees only its own tools, bound to the parent run’s deps', async () => {
    const seenDeps: Deps[] = []
    const offeredTools: string[][] = []
    const entry = (id: string) => ({
      id,
      name: id,
      description: id,
      kind: 'ai-tool' as const,
      build: (deps: Deps) => {
        return tool({
          description: id,
          inputSchema: z.object({}),
          execute: () => {
            seenDeps.push(deps)
            return Promise.resolve('ok')
          },
        })
      },
    })
    const registry: ToolRegistry<Deps> = new Map([
      ['probe', entry('probe')],
      ['vault', entry('vault')],
    ])

    let helperCalls = 0
    const getModel = () => {
      return new MockLanguageModelV3({
        doGenerate: (options) => {
          offeredTools.push((options.tools ?? []).map((t) => t.name))
          helperCalls += 1
          return Promise.resolve({
            content:
              helperCalls === 1
                ? [
                    {
                      type: 'tool-call' as const,
                      toolCallId: 'c1',
                      toolName: 'probe',
                      input: '{}',
                    },
                  ]
                : [{ type: 'text' as const, text: 'done' }],
            finishReason: mockFinish(helperCalls === 1 ? 'tool-calls' : 'stop'),
            usage: mockUsage(1, 1),
            warnings: [],
          })
        },
      })
    }

    const parentDeps: Deps = { scope: 'run-1' }
    const ctx: RunNodeContext<Deps> = {
      getModel,
      toolRegistry: registry,
      referenceKinds: [],
      toolDeps: parentDeps,
      nodeOutputs: new Map(),
      manifest: [
        {
          kind: 'agent',
          id: 'helper',
          pinnedVersion: null,
          versionId: 'helper-v1',
          versionNumber: 1,
          name: 'Helper',
          config: config({ prompt: 'HELPER', toolIds: ['probe'] }),
        },
      ],
      promptVariables: {},
      subStepRecorder: createMemoryRunRecorder(),
    }
    const tools = synthesizeDelegationTools(SUB_AGENTS, {
      ctx,
      primaryNodeId: 'p',
      streamReasoning: false,
      streamToolCalls: false,
    })
    const spawn = tools.spawn_helper.execute as (
      a: unknown,
      o: unknown,
    ) => Promise<unknown>
    const join = tools.await_subagents.execute as (
      a: unknown,
      o: unknown,
    ) => Promise<JoinResult>
    const opts = { toolCallId: 'call', messages: [] }

    await spawn({ message: 'look it up' }, opts)
    const res = await join({}, opts)

    expect(res.completed).toHaveLength(1)
    // Only the tool the helper's own config lists was offered — not `vault`,
    // which the registry holds, and no spawn tools of its own.
    expect(offeredTools.every((names) => names.join() === 'probe')).toBe(true)
    // The helper's tool ran on the parent run's deps, untouched.
    expect(seenDeps).toEqual([parentDeps])
    expect(seenDeps[0]).toBe(parentDeps)
  })

  test('an agent spawn call has no field that could name another scope', () => {
    const [info] = synthesizeTargets(
      [{ kind: 'agent', id: 'helper', version: null }],
      () => ({ displayName: 'Helper', promptVariables: ['topic'] }),
    )
    const { shape } = spawnInputSchema(info) as z.ZodObject
    expect(Object.keys(shape).sort()).toEqual(['message', 'topic'])
  })
})
