import { tool } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import { makeAgentConfig } from '../agent-test-helpers'
import type { AgentNode, AgentOutput, WfRunManifestEntry } from '../graph'
import { mockFinish, mockUsage } from '../model-test-helpers'
import type { ReferenceKind } from '../references'
import type { RunLogEntry } from '../stream-sink'
import type { ToolRegistry } from '../tool-registry'

import { executeAgentNode } from './agent'

// Inline references end to end through the agent node: the prompt teaches the
// grammar, an id the agent saw (a tool result, or an upstream input interpolated
// into its prompt) survives, an id it invented is unwrapped to its label, and
// the survivors come back structured beside the text.

const RECORD: ReferenceKind = {
  id: 'record',
  label: 'Record',
  description: 'A stored record.',
  guidance: 'Reference each record you used by its `recordId`.',
  anchor: 'The `partId` of the passage.',
  quote: true,
  example: { id: 'rec-example', label: 'Example record' },
}

const NODE: AgentNode = {
  id: 'agent',
  kind: 'agent',
  label: 'Researcher',
  position: { x: 0, y: 0 },
  informUser: { mode: 'off' },
  config: { agentId: 'bot', version: null, inputs: {} },
}

function manifest(opts: {
  referenceKinds: string[]
  prompt?: string
  output?: AgentOutput
}): WfRunManifestEntry[] {
  return [
    {
      kind: 'agent',
      id: 'bot',
      pinnedVersion: null,
      versionId: 'v1',
      versionNumber: 1,
      name: 'Researcher',
      config: makeAgentConfig({
        modelId: 'mock',
        prompt: opts.prompt ?? 'Answer from the records.',
        userPrompt: 'Go.',
        inputKind: 'task' as const,
        toolIds: ['lookup'],
        maxTurns: 3,
        output: opts.output ?? { kind: 'text' },
        referenceKinds: opts.referenceKinds,
      }),
    },
  ]
}

const REGISTRY: ToolRegistry<unknown> = new Map([
  [
    'lookup',
    {
      id: 'lookup',
      kind: 'ai-tool' as const,
      name: 'Lookup',
      description: 'Looks a record up.',
      produces: ['record'],
      build: () => {
        return tool({
          description: 'Looks a record up.',
          inputSchema: z.object({ q: z.string() }),
          execute: async () => ({ recordId: 'rec-7', partId: 'p2' }),
        })
      },
    },
  ],
])

// Turn 1 calls the tool; turn 2 answers with `answer`. Captures each system
// prompt the model was sent.
function researcher(answer: string, systems: string[]) {
  let call = 0
  return new MockLanguageModelV3({
    doGenerate: async (opts) => {
      call++
      const system = opts.prompt.find((m) => m.role === 'system')
      if (system && typeof system.content === 'string') {
        systems.push(system.content)
      }
      return call === 1
        ? {
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'c1',
                toolName: 'lookup',
                input: JSON.stringify({ q: 'x' }),
              },
            ],
            finishReason: mockFinish('tool-calls'),
            usage: mockUsage(1, 1),
            warnings: [],
          }
        : {
            content: [{ type: 'text' as const, text: answer }],
            finishReason: mockFinish('stop'),
            usage: mockUsage(1, 1),
            warnings: [],
          }
    },
  })
}

function run(args: {
  answer: string
  manifest: WfRunManifestEntry[]
  promptVariables?: Record<string, string>
  logs?: RunLogEntry[]
}) {
  const systems: string[] = []
  const result = executeAgentNode<unknown>({
    node: NODE,
    getModel: () => researcher(args.answer, systems),
    toolRegistry: REGISTRY,
    referenceKinds: [RECORD],
    toolDeps: {},
    promptVariables: args.promptVariables ?? {},
    nodeOutputs: new Map(),
    manifest: args.manifest,
    sink: { log: (e) => void args.logs?.push(e) },
  })
  return { result, systems }
}

describe('agent node — inline references', () => {
  test('appends the grammar to the prompt and keeps a sourced reference', async () => {
    const answer =
      'It is blue [Weather notes](#ref:record/rec-7/p2 "the sky is blue").'
    const { result, systems } = run({
      answer,
      manifest: manifest({ referenceKinds: ['record'] }),
    })
    const r = await result
    expect(systems[0]).toStartWith('Answer from the records.\n\n## Referencing sources')
    expect(systems[0]).toContain('### Record (`record`)')
    expect(r.output).toEqual({
      text: answer,
      references: [
        {
          kind: 'record',
          id: 'rec-7',
          anchor: 'p2',
          quote: 'the sky is blue',
          label: 'Weather notes',
        },
      ],
    })
    expect(r.meta.references).toEqual({ kept: 1, issues: [] })
  })

  test('unwraps an invented id to its label and logs a warning', async () => {
    const logs: RunLogEntry[] = []
    const { result } = run({
      answer: 'See [Made up](#ref:record/rec-404) and [Notes](#ref:record/rec-7).',
      manifest: manifest({ referenceKinds: ['record'] }),
      logs,
    })
    const r = await result
    expect((r.output as { text: string }).text).toBe(
      'See Made up and [Notes](#ref:record/rec-7).',
    )
    expect(logs.find((l) => l.level === 'warn')?.message).toContain('record/rec-404')
  })

  test('an upstream input interpolated into the prompt counts as evidence', async () => {
    const { result } = run({
      answer: 'Per the summary, [Older record](#ref:record/rec-upstream).',
      manifest: manifest({
        referenceKinds: ['record'],
        prompt: 'Build on this summary: ${summary}',
      }),
      promptVariables: {
        summary: 'Earlier finding [Older record](#ref:record/rec-upstream).',
      },
    })
    const r = await result
    expect((r.output as { references: unknown[] }).references).toHaveLength(1)
  })

  test('no kinds → prompt and output untouched', async () => {
    const answer = 'Plain [Notes](#ref:record/rec-404).'
    const { result, systems } = run({
      answer,
      manifest: manifest({ referenceKinds: [] }),
    })
    const r = await result
    expect(systems[0]).toBe('Answer from the records.')
    expect(r.output).toEqual({ text: answer })
  })

  test('an undeclared kind is an author error', async () => {
    const { result } = run({
      answer: 'x',
      manifest: manifest({ referenceKinds: ['nope'] }),
    })
    await expect(result).rejects.toThrow("reference kind 'nope' is not declared")
  })
})
