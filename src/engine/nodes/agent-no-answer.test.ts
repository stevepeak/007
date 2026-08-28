import { APICallError, tool } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import { makeAgentConfig } from '../agent-test-helpers'
import { apiErrorDetail } from '../error-detail'
import type { AgentNode, WfRunManifestEntry } from '../graph'
import {
  mockFinish,
  mockStream,
  mockUsage,
  type MockStreamPart,
} from '../model-test-helpers'
import type { StreamSink } from '../stream-sink'
import type { ToolRegistry } from '../tool-registry'

import { executeAgentNode } from './agent'
import { AGENT_NO_OUTPUT, isFatalAgentError } from './agent-generation'

// A text agent MUST come back with text. The failure this guards against isn't
// hypothetical: a model that spends every turn calling tools hits `maxTurns`
// mid-investigation, `generateText` returns `text: ''`, and the node reports
// success — so the run completes, the Output node carries the empty string, and
// the chat renders a blank message that says nothing about what went wrong.
//
// Two defenses, one per test: the last turn is denied tools so the model has to
// write its answer, and an empty answer that arrives anyway fails the node
// loudly instead of propagating.

function MANIFEST (maxTurns: number): WfRunManifestEntry[] {
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
      prompt: 'Research, then answer.',
      userPrompt: 'Go.',
      inputKind: 'task' as const,
      toolIds: ['lookup'],
      maxTurns,
      output: { kind: 'text' },
    }),
  },
]
}

const NODE: AgentNode = {
  id: 'agent',
  kind: 'agent',
  label: 'Researcher',
  position: { x: 0, y: 0 },
  informUser: { mode: 'off' },
  config: { agentId: 'bot', version: null, inputs: {} },
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
        finishReason: toolsDenied ? mockFinish('stop') : mockFinish('tool-calls'),
        usage: mockUsage(1, 1),
        warnings: [],
      }
    },
  })
}

function run (
  model: MockLanguageModelV3,
  maxTurns: number,
  sink?: StreamSink,
) {
  return executeAgentNode<unknown>({
    node: NODE,
    getModel: () => model,
    toolRegistry: REGISTRY,
    toolDeps: {},
    promptVariables: {},
    nodeOutputs: new Map(),
    manifest: MANIFEST(maxTurns),
    sink,
  })
}

// A sink that CAN stream. `delta` is what puts the node on the `streamText`
// path at all (see `streamAnswer`), so every streaming test needs one; the
// captured log lines are how we check a recovered-from error still got named.
function streamingSink(): StreamSink & {
  streamed: string[]
  logs: { level: string; message: string }[]
} {
  const streamed: string[] = []
  const logs: { level: string; message: string }[] = []
  return {
    streamed,
    logs,
    delta: (t: string) => void streamed.push(t),
    log: (entry) => void logs.push({ level: entry.level, message: entry.message }),
  }
}

/** The provider rejection a failed round-trip actually carries. */
function providerRejection(): APICallError {
  return new APICallError({
    message: 'Bad Request',
    url: 'https://api.venice.ai/api/v1/chat/completions',
    requestBodyValues: {},
    statusCode: 400,
    responseBody: '{"error":"tool role not supported"}',
    isRetryable: false,
  })
}

/**
 * A model whose stream fails, optionally after emitting a complete answer.
 *
 * The red `AI_APICallError` block these tests print is expected: `streamText`'s
 * default `onError` is a bare `console.error`, and it fires before we ever see
 * the chunk. It is not a failing assertion.
 */
function failingStream(
  error: unknown,
  answer?: string,
): MockLanguageModelV3 {
  const chunks: MockStreamPart[] = [{ type: 'stream-start', warnings: [] }]
  if (answer !== undefined) {
    chunks.push(
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: answer },
      { type: 'text-end', id: 't1' },
    )
  }
  chunks.push({ type: 'error', error })
  return new MockLanguageModelV3({ doStream: async () => mockStream(chunks) })
}

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
        finishReason: mockFinish('stop'),
        usage: mockUsage(1, 0),
        warnings: [],
      }),
    })

    const err = await run(silent, 2).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('produced no answer')
    // Marked fatal: a retry burns the same turns to reach the same silence.
    expect((err as Record<string, unknown>)[AGENT_NO_OUTPUT]).toBe(
      true,
    )
  })
})

// The streaming path fails differently, and used to fail silently. `streamText`
// never rejects: a dead round-trip arrives as an `error` chunk, `finishReason`
// becomes `error`, and `text` resolves to the empty string — so the empty-answer
// guard above was reporting a turn ceiling for what was really a provider
// outage, with the actual rejection dropped on the floor.
describe('agent node — a failed stream reports the provider error', () => {
  test('the provider error is thrown as-is, with its detail intact', async () => {
    const rejection = providerRejection()
    const sink = streamingSink()

    const err = await run(failingStream(rejection), 1, sink).catch(
      (e: unknown) => e,
    )

    // Thrown UNWRAPPED — that is what keeps the status code and response body
    // readable downstream instead of a message that has to be parsed back out.
    expect(err).toBe(rejection)
    expect(apiErrorDetail(err)?.statusCode).toBe(400)
    expect(apiErrorDetail(err)?.responseBody).toContain('tool role not supported')
    // NOT fatal: unlike a spent turn ceiling, the engine's own retry policy
    // decides this one (here, `isRetryable: false` will stop it).
    expect(isFatalAgentError(err)).toBe(false)
    expect(sink.logs.some((l) => l.level === 'error')).toBe(true)
  })

  test('an error after a complete answer does not discard the answer', async () => {
    const sink = streamingSink()

    const result = await run(
      failingStream(providerRejection(), 'Here is what I found.'),
      1,
      sink,
    )

    // The reader already watched this stream in; throwing it away now would
    // replace a good answer with an error message.
    expect((result.output as { text: string }).text).toBe('Here is what I found.')
    expect(sink.streamed.join('')).toBe('Here is what I found.')
    // Still named in the feed — a recovered-from fault is invisible otherwise.
    expect(sink.logs.some((l) => l.level === 'error')).toBe(true)
  })

  test('an empty answer with no error part still names the failed call', async () => {
    const sink = streamingSink()
    const silent = new MockLanguageModelV3({
      doStream: async () =>
        mockStream([
          { type: 'stream-start', warnings: [] },
          {
            type: 'finish',
            finishReason: mockFinish('error'),
            usage: mockUsage(1, 0),
          },
        ]),
    })

    const err = await run(silent, 1, sink).catch((e: unknown) => e)

    expect((err as Error).message).toContain("model call failed")
    expect((err as Error).message).not.toContain('produced no answer')
    // No evidence a second attempt hits the same wall, so not marked fatal.
    expect(isFatalAgentError(err)).toBe(false)
  })
})

// Running out of output tokens is its own diagnosis: the model never got to the
// answer, typically because reasoning ate the budget. Reported as a cut-off, not
// as a turn ceiling, and fatal — the same prompt reasons to the same cliff.
describe('agent node — cut off before answering', () => {
  test('a `length` finish is named as a cut-off and stays fatal', async () => {
    const cutOff = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [],
        finishReason: mockFinish('length'),
        usage: mockUsage(1, 4096),
        warnings: [],
      }),
    })

    const err = await run(cutOff, 2).catch((e: unknown) => e)

    expect((err as Error).message).toContain('cut off before it wrote an answer')
    expect((err as Error).message).not.toContain('produced no answer')
    expect((err as Record<string, unknown>)[AGENT_NO_OUTPUT]).toBe(true)
  })
})
