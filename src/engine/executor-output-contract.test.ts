import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import type { RunCompletion, WfSdkConfig } from './config'
import { executeWorkflow } from './executor'
import { createMemoryRunRecorder } from './run-recorder'
import type { ToolRegistry } from './tool-registry'

// End-to-end (in-process backend) proof that a trigger's output contract is
// enforced at run finish: a run whose bound Output value satisfies the contract
// completes, one that violates it FAILS loudly instead of returning a bad value.

type Deps = { subject: string }

const toolRegistry: ToolRegistry<Deps> = new Map([
  [
    'reply',
    {
      id: 'reply',
      name: 'Reply',
      kind: 'function',
      description: 'Returns a { text } reply.',
      build: () => () => Promise.resolve({ text: 'hello' }),
    },
  ],
  [
    'bad',
    {
      id: 'bad',
      name: 'Bad',
      kind: 'function',
      description: 'Returns a shape that violates the { text } contract.',
      build: () => () => Promise.resolve({ notText: 1 }),
    },
  ],
])

function makeConfig(
  hooks: Partial<Pick<WfSdkConfig<Deps>, 'onRunComplete' | 'onRunFailed'>> = {},
): WfSdkConfig<Deps> {
  return {
    getModel: () => {
      throw new Error('no model needed')
    },
    listModels: () => [],
    listProviders: () => [],
    toolRegistry,
    triggers: {
      chat: {
        description: 'Chat',
        inputSchema: z.object({}),
        outputContractSchema: z.object({ text: z.string() }),
      },
    },
    buildRunDeps: (ctx) => ({ subject: ctx.subjectId ?? '' }),
    ...hooks,
  }
}

function graph(toolId: 'reply' | 'bad') {
  return {
    version: 1 as const,
    nodes: [
      {
        id: 't',
        kind: 'trigger',
        label: 'Chat',
        position: { x: 0, y: 0 },
        config: { triggerKind: 'chat' },
      },
      {
        id: 'work',
        kind: 'tool',
        label: 'Work',
        position: { x: 200, y: 0 },
        config: { toolId, args: {} },
      },
      {
        id: 'o',
        kind: 'output',
        label: 'Out',
        position: { x: 400, y: 0 },
        config: { source: { kind: 'ref', nodeId: 'work', path: '' } },
      },
    ],
    edges: [
      { id: 'e1', source: 't', target: 'work', condition: null },
      { id: 'e2', source: 'work', target: 'o', condition: null },
    ],
  }
}

describe('executor — output contract enforcement', () => {
  test('a run whose bound Output satisfies the contract completes', async () => {
    const completions: RunCompletion[] = []
    const result = await executeWorkflow({
      graph: graph('reply'),
      triggerInput: {},
      config: makeConfig({ onRunComplete: (_c, r) => void completions.push(r) }),
      runContext: { subjectId: 'acme', triggerKind: 'chat' },
      recorder: createMemoryRunRecorder(),
    })
    expect(result.output).toEqual({ text: 'hello' })
    expect(result.outputNodeId).toBe('o')
    expect(completions).toEqual([{ output: { text: 'hello' }, outputNodeId: 'o' }])
  })

  test('a run whose bound Output violates the contract fails loudly', async () => {
    const failures: { error: string }[] = []
    await expect(
      executeWorkflow({
        graph: graph('bad'),
        triggerInput: {},
        config: makeConfig({ onRunFailed: (_c, f) => void failures.push(f) }),
        runContext: { subjectId: 'acme', triggerKind: 'chat' },
        recorder: createMemoryRunRecorder(),
      }),
    ).rejects.toThrow(/does not satisfy the 'chat' trigger contract/)
    expect(failures).toHaveLength(1)
  })
})
