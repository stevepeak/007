import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, test } from 'bun:test'

import type { AgentNode, WfRunManifestEntry } from '../graph'
import { executeAgentNode } from './agent'

// A YES/NO (boolean) output agent doubles as a Branch: `executeAgentNode`
// returns a `decision` ('yes'/'no') derived from the model's `answer`, which the
// dispatcher threads into `branchResult` so the node's outgoing yes/no edges
// route. Its full `{ answer, reason }` object stays the node output.

function manifest(output: {
  kind: 'boolean' | 'text'
}): WfRunManifestEntry[] {
  return [
    {
      kind: 'agent',
      id: 'gate',
      pinnedVersion: null,
      versionId: 'v1',
      versionNumber: 1,
      name: 'Gate',
      config: {
        modelId: 'mock',
        prompt: 'Is this urgent?',
        toolIds: [],
        maxTurns: 1,
        exposeThinking: false,
        output,
      },
    },
  ]
}

const gateNode: AgentNode = {
  id: 'gate',
  kind: 'agent',
  label: 'Gate',
  position: { x: 0, y: 0 },
  config: { agentId: 'gate', version: null, inputs: {}, imageInputs: {} },
}

// A generateObject-style mock: returns the object as a JSON text part, which the
// AI SDK parses back into `result.object`.
function booleanModel(answer: boolean, reason: string) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ answer, reason }) }],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }),
  })
}

async function runGate(answer: boolean, reason: string) {
  return executeAgentNode<unknown>({
    node: gateNode,
    input: 'a message',
    getModel: () => booleanModel(answer, reason),
    toolRegistry: new Map(),
    toolDeps: {},
    promptVariables: {},
    nodeOutputs: new Map(),
    manifest: manifest({ kind: 'boolean' }),
  })
}

describe('agent node — YES/NO output as a decision', () => {
  test('a true answer yields the yes decision and keeps the object output', async () => {
    const r = await runGate(true, 'looks urgent')
    expect(r.output).toEqual({ answer: true, reason: 'looks urgent' })
    expect(r.decision).toBe('yes')
    expect(r.decisionReasoning).toBe('looks urgent')
  })

  test('a false answer yields the no decision', async () => {
    const r = await runGate(false, 'not urgent')
    expect(r.decision).toBe('no')
    expect(r.decisionReasoning).toBe('not urgent')
  })

  test('a text-output agent produces no decision', async () => {
    const r = await executeAgentNode<unknown>({
      node: gateNode,
      input: 'a message',
      getModel: () =>
        new MockLanguageModelV3({
          doGenerate: async () => ({
            content: [{ type: 'text', text: 'just some prose' }],
            finishReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            warnings: [],
          }),
        }),
      toolRegistry: new Map(),
      toolDeps: {},
      promptVariables: {},
      nodeOutputs: new Map(),
      manifest: manifest({ kind: 'text' }),
    })
    expect(r.output).toEqual({ text: 'just some prose' })
    expect(r.decision).toBeUndefined()
  })
})
