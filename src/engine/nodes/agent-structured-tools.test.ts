import { tool } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import { makeAgentConfig } from '../agent-test-helpers'
import type { AgentNode, AgentOutput, WfRunManifestEntry } from '../graph'
import { mockFinish, mockUsage } from '../model-test-helpers'
import type { ToolRegistry } from '../tool-registry'

import { executeAgentNode } from './agent'

// A structured-output agent used to be generated in ONE `generateObject` call
// with no tools — whatever the config attached. The live case: a conflict
// checker with two Clio lookups attached, a strict schema, and a prompt that
// said "use the tool" — the model never saw a tool, and the run completed with
// a made-up `NOT_REQUIRED` and no indication anything was withheld.
//
// A structured agent now runs the same tool loop as a text one and takes its
// object from the final turn. These pin the routing: tools ARE offered when
// there is room to call them, the schema is asked for on the answering turn
// only, the final turn yields the schema's object (and a YES/NO decision still
// routes), and the two shapes that could never call tools — no tools, or one
// turn — stay on the single call they made before.

const SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['CLEAR', 'FLAG'] },
    matched: { type: 'string' },
  },
  required: ['decision', 'matched'],
  additionalProperties: false,
}

function MANIFEST(
  output: AgentOutput,
  maxTurns: number,
  toolIds: string[] = ['lookup'],
): WfRunManifestEntry[] {
  return [
    {
      kind: 'agent',
      id: 'checker',
      pinnedVersion: null,
      versionId: 'v1',
      versionNumber: 1,
      name: 'Checker',
      config: makeAgentConfig({
        modelId: 'mock',
        prompt: 'Look the party up, then decide.',
        userPrompt: 'Go.',
        inputKind: 'task' as const,
        toolIds,
        maxTurns,
        output,
      }),
    },
  ]
}

const NODE: AgentNode = {
  id: 'agent',
  kind: 'agent',
  label: 'Checker',
  position: { x: 0, y: 0 },
  informUser: { mode: 'off' },
  config: { agentId: 'checker', version: null, inputs: {} },
}

const REGISTRY: ToolRegistry<unknown> = new Map([
  [
    'lookup',
    {
      id: 'lookup',
      kind: 'ai-tool' as const,
      name: 'Lookup',
      description: 'Looks a party up.',
      build: () => {
        return tool({
          description: 'Looks a party up.',
          inputSchema: z.object({ name: z.string() }),
          execute: async ({ name }) => ({ match: `${name} (former client)` }),
        })
      },
    },
  ],
])

type Seen = {
  /** Tool names offered on each round-trip — `[]` when the call carried none. */
  toolsOffered: string[][]
  /** The response format asked for on each round-trip. */
  formats: (string | undefined)[]
}

/** A model that calls the lookup whenever it may, then answers with `answer`
 * once tools are withheld (or once it has a result to answer from). */
function lookupThenAnswer(seen: Seen, answer: string) {
  return new MockLanguageModelV3({
    doGenerate: async (opts) => {
      const o = opts as {
        tools?: { name: string }[]
        toolChoice?: { type?: string }
        responseFormat?: { type?: string }
        prompt: { role: string }[]
      }
      seen.toolsOffered.push((o.tools ?? []).map((t) => t.name))
      seen.formats.push(o.responseFormat?.type)
      const mayCall =
        (o.tools?.length ?? 0) > 0 && o.toolChoice?.type !== 'none'
      const alreadyLookedUp = o.prompt.some((m) => m.role === 'tool')
      if (mayCall && !alreadyLookedUp) {
        return {
          content: [
            {
              type: 'tool-call' as const,
              toolCallId: 'c1',
              toolName: 'lookup',
              input: JSON.stringify({ name: 'Dana White' }),
            },
          ],
          finishReason: mockFinish('tool-calls'),
          usage: mockUsage(1, 1),
          warnings: [],
        }
      }
      return {
        content: [{ type: 'text' as const, text: answer }],
        finishReason: mockFinish('stop'),
        usage: mockUsage(1, 1),
        warnings: [],
      }
    },
  })
}

function run(model: MockLanguageModelV3, manifest: WfRunManifestEntry[]) {
  return executeAgentNode<unknown>({
    node: NODE,
    getModel: () => model,
    toolRegistry: REGISTRY,
    toolDeps: {},
    promptVariables: {},
    nodeOutputs: new Map(),
    manifest,
  })
}

const OBJECT: AgentOutput = { kind: 'object', schema: SCHEMA }
const ANSWER = JSON.stringify({ decision: 'FLAG', matched: 'Dana White' })

describe('agent node — structured output with tools', () => {
  test('an object agent with tools calls them, then answers with the object on its final turn', async () => {
    const seen: Seen = { toolsOffered: [], formats: [] }
    const result = await run(
      lookupThenAnswer(seen, ANSWER),
      MANIFEST(OBJECT, 2),
    )

    // Turn 1 saw the tool and called it; turn 2 answered from the result.
    expect(seen.toolsOffered).toEqual([['lookup'], ['lookup']])
    // The schema reaches the provider on the answering turn ONLY: a research
    // turn sent with `response_format` never calls a tool on a provider that
    // enforces it (Venice/DeepSeek, measured), so it goes out without one.
    expect(seen.formats).toEqual([undefined, 'json'])
    expect(result.output).toEqual({ decision: 'FLAG', matched: 'Dana White' })
    expect(result.meta.steps).toHaveLength(2)
    expect(result.meta.steps[0]?.toolCalls).toEqual([
      {
        toolCallId: 'c1',
        toolName: 'lookup',
        input: { name: 'Dana White' },
        output: { match: 'Dana White (former client)' },
      },
    ])
  })

  test('answering early, in prose, on a research turn gets one schema-only call over the transcript', async () => {
    const seen: Seen = { toolsOffered: [], formats: [] }
    // Turn 2 of 3 is a research turn: no schema, and this model wraps up in
    // prose there. The object then has to come from a formatting call that
    // sees the tool result — three round-trips, the last with the schema and
    // no tools.
    let prose = true
    const model = new MockLanguageModelV3({
      doGenerate: async (opts) => {
        const o = opts as {
          tools?: { name: string }[]
          responseFormat?: { type?: string }
          prompt: { role: string }[]
        }
        seen.toolsOffered.push((o.tools ?? []).map((t) => t.name))
        seen.formats.push(o.responseFormat?.type)
        if (!o.prompt.some((m) => m.role === 'tool')) {
          return {
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'c1',
                toolName: 'lookup',
                input: JSON.stringify({ name: 'Dana White' }),
              },
            ],
            finishReason: mockFinish('tool-calls'),
            usage: mockUsage(1, 1),
            warnings: [],
          }
        }
        const text = prose ? 'Dana White is a former client, so: FLAG.' : ANSWER
        prose = false
        return {
          content: [{ type: 'text' as const, text }],
          finishReason: mockFinish('stop'),
          usage: mockUsage(1, 1),
          warnings: [],
        }
      },
    })
    const result = await run(model, MANIFEST(OBJECT, 3))

    expect(seen.toolsOffered).toEqual([['lookup'], ['lookup'], []])
    expect(seen.formats).toEqual([undefined, undefined, 'json'])
    expect(result.output).toEqual({ decision: 'FLAG', matched: 'Dana White' })
    // The formatting call is a recorded step of its own, so the trace shows
    // the prose the model wrote AND the object it was shaped into.
    expect(result.meta.steps.map((s) => s.text)).toEqual([
      '',
      'Dana White is a former client, so: FLAG.',
      ANSWER,
    ])
  })

  test('a YES/NO agent with tools still routes its decision off the final object', async () => {
    const seen: Seen = { toolsOffered: [], formats: [] }
    const result = await run(
      lookupThenAnswer(
        seen,
        JSON.stringify({ answer: true, reason: 'former client' }),
      ),
      MANIFEST({ kind: 'boolean' }, 2),
    )

    expect(seen.toolsOffered).toEqual([['lookup'], ['lookup']])
    expect(result.decision).toBe('yes')
    expect(result.decisionReasoning).toBe('former client')
  })

  // The transcript call is also the retry for a mangled answering turn — the
  // lone `{` seen in production. It is re-issued once (the single-call path's
  // rule) and then the failure propagates rather than looping.
  test('a mangled answering turn is retried from the transcript; a body that never parses fails the node', async () => {
    const seen: Seen = { toolsOffered: [], formats: [] }
    await expect(
      run(lookupThenAnswer(seen, '{"decision":'), MANIFEST(OBJECT, 2)),
    ).rejects.toThrow(/No object generated/)
    // Turn 1 research, turn 2 answering (mangled), then the transcript call and
    // its one re-issue — both with the schema, neither with tools.
    expect(seen.toolsOffered).toEqual([['lookup'], ['lookup'], [], []])
    expect(seen.formats).toEqual([undefined, 'json', 'json', 'json'])
  })

  test('one turn: tools attached but never offered — the single structured call, as before', async () => {
    const seen: Seen = { toolsOffered: [], formats: [] }
    const result = await run(
      lookupThenAnswer(seen, ANSWER),
      MANIFEST(OBJECT, 1),
    )

    expect(seen.toolsOffered).toEqual([[]])
    expect(result.output).toEqual({ decision: 'FLAG', matched: 'Dana White' })
  })

  test('no tools: the single structured call, whatever maxTurns says', async () => {
    const seen: Seen = { toolsOffered: [], formats: [] }
    const result = await run(
      lookupThenAnswer(seen, ANSWER),
      MANIFEST(OBJECT, 5, []),
    )

    expect(seen.toolsOffered).toEqual([[]])
    expect(result.output).toEqual({ decision: 'FLAG', matched: 'Dana White' })
  })
})
