import { tool } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import type { AgentNode, WfRunManifestEntry } from '../graph'
import type { ToolRegistry } from '../tool-registry'

import { executeAgentNode } from './agent'

// `requireToolFirstTurn` forces turn 1 to call a tool, for the agent whose answer
// is only trustworthy if it looked something up. The interesting cases are the
// ones where it must NOT apply: it shares `prepareStep` with the rule that denies
// tools on the final turn, and that rule has to win — a forced tool call with no
// turn left to answer with the result is exactly the empty-`text` run that rule
// exists to prevent (see agent-no-answer.test.ts).

// What an unconstrained turn looks like on the wire: `prepareStep` returning
// `{}` leaves the SDK's default, which normalizes to an explicit `auto` rather
// than an absent field.
const AUTO = { type: 'auto' }

const MANIFEST = (
  maxTurns: number,
  requireToolFirstTurn: boolean,
  toolIds: string[] = ['lookup'],
): WfRunManifestEntry[] => [
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
      toolIds,
      maxTurns,
      requireToolFirstTurn,
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
          execute: async () => ({ hit: 'the statute' }),
        }),
    },
  ],
])

// The agent this setting exists for: it would happily answer from what it
// "knows" on turn 1, and only reaches for a tool when the choice is taken away.
function eagerAnswerer(seen: { toolChoices: unknown[] }) {
  let call = 0
  return new MockLanguageModelV3({
    doGenerate: async (opts) => {
      const choice = (opts as { toolChoice?: { type?: string } }).toolChoice
      seen.toolChoices.push(choice)
      call++
      return {
        content:
          choice?.type === 'required'
            ? [
                {
                  type: 'tool-call' as const,
                  toolCallId: `c${call}`,
                  toolName: 'lookup',
                  input: JSON.stringify({ q: 'the statute' }),
                },
              ]
            : [{ type: 'text' as const, text: 'Answer.' }],
        finishReason:
          choice?.type === 'required'
            ? ('tool-calls' as const)
            : ('stop' as const),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      }
    },
  })
}

const run = (
  model: MockLanguageModelV3,
  manifest: WfRunManifestEntry[],
  toolRegistry: ToolRegistry<unknown> = REGISTRY,
) =>
  executeAgentNode<unknown>({
    node: NODE,
    input: 'does the policy cover flood damage?',
    getModel: () => model,
    toolRegistry,
    toolDeps: {},
    promptVariables: {},
    nodeOutputs: new Map(),
    manifest,
  })

describe('agent node — requireToolFirstTurn', () => {
  test('turn 1 is forced to call a tool, later turns are free to answer', async () => {
    const seen: { toolChoices: unknown[] } = { toolChoices: [] }
    const result = await run(eagerAnswerer(seen), MANIFEST(3, true))

    expect((result.output as { text: string }).text).toBe('Answer.')
    // Forced on turn 1 only — turn 2 is unconstrained and answers immediately,
    // so the loop never reaches the final turn's tool denial.
    expect(seen.toolChoices).toEqual([{ type: 'required' }, AUTO])
  })

  test('off by default: the same model answers turn 1 without calling anything', async () => {
    const seen: { toolChoices: unknown[] } = { toolChoices: [] }
    const result = await run(eagerAnswerer(seen), MANIFEST(3, false))

    expect((result.output as { text: string }).text).toBe('Answer.')
    expect(seen.toolChoices).toEqual([AUTO])
  })

  test('inert at maxTurns 1 — the final turn still denies tools', async () => {
    const seen: { toolChoices: unknown[] } = { toolChoices: [] }
    const result = await run(eagerAnswerer(seen), MANIFEST(1, true))

    // Turn 1 is also the answering turn. Forcing a tool here would leave the
    // loop with a tool result and no turn to write it up.
    expect(seen.toolChoices).toEqual([{ type: 'none' }])
    expect((result.output as { text: string }).text).toBe('Answer.')
  })

  test('inert with no tools attached — nothing to require', async () => {
    const seen: { toolChoices: unknown[] } = { toolChoices: [] }
    const result = await run(
      eagerAnswerer(seen),
      MANIFEST(3, true, []),
      new Map(),
    )

    expect(seen.toolChoices).toEqual([AUTO])
    expect((result.output as { text: string }).text).toBe('Answer.')
  })
})
