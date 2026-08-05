import { tool } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import type { AgentNode, WfRunManifestEntry } from '../graph'
import type { ToolRegistry } from '../tool-registry'

import { executeAgentNode } from './agent'
import { AGENT_NO_OUTPUT } from './agent-generation'

// A text agent MUST come back with text. The failure this guards against isn't
// hypothetical: a model that spends every turn calling tools hits `maxTurns`
// mid-investigation, `generateText` returns `text: ''`, and the node reports
// success — so the run completes, the Output node carries the empty string, and
// the chat renders a blank message that says nothing about what went wrong.
//
// Two defenses, one per test: the last turn is denied tools so the model has to
// write its answer, and an empty answer that arrives anyway fails the node
// loudly instead of propagating.

const MANIFEST = (maxTurns: number): WfRunManifestEntry[] => [
  {
    kind: 'agent',
    id: 'bot',
    pinnedVersion: null,
    versionId: 'v1',
    versionNumber: 1,
    name: 'Researcher',
    config: {
      modelId: 'mock',
      prompt: 'Research, then answer.',
      toolIds: ['lookup'],
      maxTurns,
      output: { kind: 'text' },
    },
  },
]

const NODE: AgentNode = {
  id: 'agent',
  kind: 'agent',
  label: 'Researcher',
  position: { x: 0, y: 0 },
  informUser: { mode: 'off' },
  config: { agentId: 'bot', version: null, inputs: {}, imageInputs: {} },
}

const REGISTRY: ToolRegistry<unknown> = new Map([
  [
    'lookup',
    {
      id: 'lookup',
      kind: 'ai-tool' as const,
      name: 'Lookup',
      description: 'Looks something up.',
      build: () =>
        tool({
          description: 'Looks something up.',
          inputSchema: z.object({ q: z.string() }),
          execute: async () => ({ hit: 'something' }),
        }),
    },
  ],
])

// A model that would call `lookup` forever if allowed to — the shape of every
// agent that runs itself out of turns. It answers only when denied tools.
function insatiableResearcher(seen: { toolChoices: unknown[] }) {
  let call = 0
  return new MockLanguageModelV3({
    doGenerate: async (opts) => {
      const o = opts as { toolChoice?: unknown }
      seen.toolChoices.push(o.toolChoice)
      const toolsDenied =
        (o.toolChoice as { type?: string } | undefined)?.type === 'none'
      call++
      return {
        content: toolsDenied
          ? [{ type: 'text' as const, text: 'Here is what I found.' }]
          : [
              {
                type: 'tool-call' as const,
                toolCallId: `c${call}`,
                toolName: 'lookup',
                input: JSON.stringify({ q: 'again' }),
              },
            ],
        finishReason: toolsDenied ? ('stop' as const) : ('tool-calls' as const),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      }
    },
  })
}

const run = (model: MockLanguageModelV3, maxTurns: number) =>
  executeAgentNode<unknown>({
    node: NODE,
    input: 'draft the coverage opinion',
    getModel: () => model,
    toolRegistry: REGISTRY,
    toolDeps: {},
    promptVariables: {},
    nodeOutputs: new Map(),
    manifest: MANIFEST(maxTurns),
  })

describe('agent node — never finishes empty', () => {
  test('the last turn is denied tools, so the model has to answer', async () => {
    const seen: { toolChoices: unknown[] } = { toolChoices: [] }
    const result = await run(insatiableResearcher(seen), 3)

    expect((result.output as { text: string }).text).toBe(
      'Here is what I found.',
    )
    // Tools stay available right up to the final turn, which forces prose.
    expect(seen.toolChoices).toHaveLength(3)
    expect(seen.toolChoices[0]).not.toEqual({ type: 'none' })
    expect(seen.toolChoices[1]).not.toEqual({ type: 'none' })
    expect(seen.toolChoices[2]).toEqual({ type: 'none' })
  })

  test('an empty answer fails the node instead of propagating', async () => {
    const silent = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text' as const, text: '   ' }],
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
        warnings: [],
      }),
    })

    const err = await run(silent, 2).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('produced no answer')
    // Marked fatal: a retry burns the same turns to reach the same silence.
    expect((err as unknown as Record<string, unknown>)[AGENT_NO_OUTPUT]).toBe(
      true,
    )
  })
})
