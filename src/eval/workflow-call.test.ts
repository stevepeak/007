import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import type {
  ToolRegistry,
  WfRunManifestEntry,
  WfSdkConfig,
  WorkflowGraph,
} from '../engine'
import { runWorkflowUnderConditions } from './index'

// End-to-end proof that a `workflow` node calls another workflow and awaits its
// result: the callee's frozen graph (in the run manifest) runs INLINE as a
// subgraph via the same executor path, its Output value becomes the calling
// node's output, and the whole call is recorded as ONE step in the parent trace.

// A parent graph: manual trigger → workflow node (calls `wf-callee`) → output.
const parentGraph = {
  version: 1,
  nodes: [
    {
      id: 't',
      kind: 'trigger',
      label: 'Start',
      position: { x: 0, y: 0 },
      config: { triggerKind: 'manual' },
    },
    {
      id: 'w',
      kind: 'workflow',
      label: 'Call callee',
      position: { x: 200, y: 0 },
      config: { workflowId: 'wf-callee', inputs: {} },
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
    { id: 'e1', source: 't', target: 'w', condition: null },
    { id: 'e2', source: 'w', target: 'o', condition: null },
  ],
}

describe('eval harness — workflow-calls-workflow (tool callee)', () => {
  type Deps = { subject: string }

  const toolRegistry: ToolRegistry<Deps> = new Map([
    [
      'shout',
      {
        id: 'shout',
        name: 'Shout',
        kind: 'function',
        description: 'Uppercases its text arg.',
        build: (deps) => (args) => {
          const { text } = args as { text: string }
          return Promise.resolve({
            shouted: text.toUpperCase(),
            subject: deps.subject,
          })
        },
      },
    ],
  ])

  const config: WfSdkConfig<Deps> = {
    getModel: () => {
      throw new Error('no model needed')
    },
    listModels: () => [],
    toolRegistry,
    triggers: {},
    buildRunDeps: (ctx) => ({ subject: ctx.subjectId ?? '' }),
  }

  // The callee: manual trigger → shout tool (binds the whole trigger input) →
  // output. Its output is the shout result.
  const calleeGraph: WorkflowGraph = {
    version: 1,
    nodes: [
      {
        id: 'ct',
        kind: 'trigger',
        label: 'Start',
        position: { x: 0, y: 0 },
        config: { triggerKind: 'manual' },
      },
      {
        id: 'shout',
        kind: 'tool',
        label: 'Shout',
        position: { x: 200, y: 0 },
        config: {
          toolId: 'shout',
          args: { text: { kind: 'ref', nodeId: 'ct', path: '' } },
        },
      },
      {
        id: 'co',
        kind: 'output',
        label: 'Out',
        position: { x: 400, y: 0 },
        config: {},
      },
    ],
    edges: [
      { id: 'e1', source: 'ct', target: 'shout', condition: null },
      { id: 'e2', source: 'shout', target: 'co', condition: null },
    ],
  }

  const manifest: WfRunManifestEntry[] = [
    {
      kind: 'workflow',
      id: 'wf-callee',
      versionId: 'v1',
      versionNumber: 1,
      name: 'Shout Workflow',
      graph: calleeGraph,
    },
  ]

  test('runs the callee inline and surfaces its output; records one step', async () => {
    const run = await runWorkflowUnderConditions({
      name: 'workflow call',
      graph: parentGraph,
      triggerInput: 'hello',
      config,
      manifest,
      runContext: { subjectId: 'acme' },
    })

    expect(run.output).toEqual({ shouted: 'HELLO', subject: 'acme' })
    // The parent trace has exactly trigger → workflow → output — the callee's
    // inner trigger/tool/output steps run inline and are NOT separately recorded.
    expect(run.steps.map((s) => s.nodeKind)).toEqual([
      'trigger',
      'workflow',
      'output',
    ])
    const wStep = run.steps.find((s) => s.nodeId === 'w')
    expect(wStep?.status).toBe('completed')
    expect((wStep?.meta as { name?: string })?.name).toBe('Shout Workflow')
  })
})

describe('eval harness — workflow-calls-workflow (agent callee, nested manifest)', () => {
  const config: WfSdkConfig<unknown> = {
    getModel: () =>
      new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: 'text', text: 'Hi from callee' }],
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          warnings: [],
        }),
      }),
    listModels: () => [{ id: 'mock', label: 'Mock' }],
    toolRegistry: new Map(),
    triggers: {},
    buildRunDeps: () => ({}),
  }

  // The callee runs an agent — proving the callee's OWN references resolve from
  // the same flat run manifest that the transitive resolver would have built.
  const calleeGraph: WorkflowGraph = {
    version: 1,
    nodes: [
      {
        id: 'ct',
        kind: 'trigger',
        label: 'Start',
        position: { x: 0, y: 0 },
        config: { triggerKind: 'manual' },
      },
      {
        id: 'a',
        kind: 'agent',
        label: 'Assistant',
        position: { x: 200, y: 0 },
        config: { agentId: 'assistant', inputs: {}, imageInputs: {} },
      },
      {
        id: 'co',
        kind: 'output',
        label: 'Out',
        position: { x: 400, y: 0 },
        config: {},
      },
    ],
    edges: [
      { id: 'e1', source: 'ct', target: 'a', condition: null },
      { id: 'e2', source: 'a', target: 'co', condition: null },
    ],
  }

  const manifest: WfRunManifestEntry[] = [
    {
      kind: 'workflow',
      id: 'wf-callee',
      versionId: 'v1',
      versionNumber: 1,
      name: 'Agent Workflow',
      graph: calleeGraph,
    },
    {
      kind: 'agent',
      id: 'assistant',
      versionId: 'av1',
      versionNumber: 1,
      name: 'Assistant',
      config: {
        modelId: 'mock',
        prompt: 'Be helpful.',
        toolIds: [],
        maxTurns: 1,
        exposeThinking: false,
        output: { kind: 'text' },
      },
    },
  ]

  test('the callee agent resolves from the shared manifest and runs', async () => {
    const run = await runWorkflowUnderConditions({
      name: 'workflow call agent',
      graph: parentGraph,
      triggerInput: { messages: [{ role: 'user', parts: [] }] },
      config,
      manifest,
    })
    expect(run.output).toEqual({ text: 'Hi from callee' })
    expect(run.steps.map((s) => s.nodeKind)).toEqual([
      'trigger',
      'workflow',
      'output',
    ])
  })
})
