import { simulateReadableStream, tool, type UIMessage } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import {
  mockFinish,
  mockUsage,
  type MockStreamPart,
} from '../model-test-helpers'
import type { RunLogEntry, StreamSink } from '../stream-sink'

import { runAgentGeneration } from './agent-generation'
import { createTurnClock, turnTiming } from './agent-generation-timing'

// A slow agent step raises one question — was it the model or a tool, and if
// the model, was it thinking or writing? These pin that every turn and every
// tool call records enough to answer it, and that the feed's tool lines carry
// the moment the tool actually ran rather than the moment the turn ended.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function capturingSink(over: Partial<StreamSink> = {}): StreamSink & {
  entries: RunLogEntry[]
} {
  const entries: RunLogEntry[] = []
  return {
    entries,
    log: (e) => void entries.push(e),
    ...over,
  }
}

const MESSAGES: UIMessage[] = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Go.' }] },
]

const TOOL_MS = 40
const MODEL_MS = 25

/** One tool call on turn 1, then an answer — each model call takes MODEL_MS. */
function researcher() {
  let call = 0
  return new MockLanguageModelV3({
    doGenerate: async () => {
      call++
      await sleep(MODEL_MS)
      return {
        content:
          call === 1
            ? [
                {
                  type: 'tool-call' as const,
                  toolCallId: 'c1',
                  toolName: 'lookup',
                  input: JSON.stringify({ q: 'x' }),
                },
              ]
            : [{ type: 'text' as const, text: 'Found it.' }],
        finishReason: mockFinish(call === 1 ? 'tool-calls' : 'stop'),
        usage: mockUsage(10, 5),
        warnings: [],
      }
    },
  })
}

const TOOLS = {
  lookup: tool({
    description: 'Looks something up.',
    inputSchema: z.object({ q: z.string() }),
    execute: async () => {
      await sleep(TOOL_MS)
      return { hit: 'something' }
    },
  }),
}

describe('agent turn timing — engine capture', () => {
  test('every turn and tool call records ms-precision timing', async () => {
    const sink = capturingSink()
    const result = await runAgentGeneration({
      model: researcher(),
      modelId: 'mock',
      output: { kind: 'text' },
      maxTurns: 3,
      streamReasoning: false,
      streamToolCalls: false,
      systemPrompt: 'Research.',
      messages: MESSAGES,
      tools: TOOLS,
      sink,
    })

    const [first, second] = result.meta.steps
    // Turn 1: a model call, then the tool.
    expect(first.startedAt).toBeNumber()
    expect(first.modelMs).toBeGreaterThanOrEqual(MODEL_MS - 5)
    expect(first.toolMs).toBeGreaterThanOrEqual(TOOL_MS - 5)
    expect(first.durationMs).toBeGreaterThanOrEqual(
      first.modelMs! + first.toolMs! - 5,
    )
    const call = first.toolCalls[0]
    expect(call.durationMs).toBeGreaterThanOrEqual(TOOL_MS - 5)
    expect(call.finishedAt! - call.startedAt!).toBe(call.durationMs!)
    expect(call.startedAt!).toBeGreaterThanOrEqual(first.startedAt!)
    expect(call.failed).toBeUndefined()

    // Turn 2: the answer, no tools — and it starts after turn 1 ended.
    expect(second.toolMs).toBeUndefined()
    expect(second.startedAt!).toBeGreaterThanOrEqual(call.finishedAt!)
    // Not streamed, so model time can't be split.
    expect(second.reasoningMs).toBeUndefined()
    expect(second.firstOutputMs).toBeUndefined()
  })

  test('tool lines go out when the tool runs, once each, the end line with its duration', async () => {
    const sink = capturingSink()
    const result = await runAgentGeneration({
      model: researcher(),
      modelId: 'mock',
      output: { kind: 'text' },
      maxTurns: 3,
      streamReasoning: false,
      streamToolCalls: false,
      systemPrompt: 'Research.',
      messages: MESSAGES,
      tools: TOOLS,
      sink,
    })
    const call = result.meta.steps[0].toolCalls[0]
    const toolLines = sink.entries.filter((e) => e.level === 'tool')
    expect(toolLines).toHaveLength(2)
    expect(toolLines[0].message).toBe('Called lookup')
    expect(toolLines[1].message).toMatch(/^lookup finished in \d+ms$/)
    // Stamped with the real instants, not the turn end.
    expect(toolLines[0].ts).toBe(call.startedAt)
    expect(toolLines[1].ts).toBe(call.finishedAt)
    expect(toolLines[1].meta).toMatchObject({
      tool: 'lookup',
      toolCallId: 'c1',
      durationMs: call.durationMs,
    })
  })

  test('a tool that throws is timed and marked failed', async () => {
    const sink = capturingSink()
    const result = await runAgentGeneration({
      model: researcher(),
      modelId: 'mock',
      output: { kind: 'text' },
      maxTurns: 3,
      streamReasoning: false,
      streamToolCalls: false,
      systemPrompt: 'Research.',
      messages: MESSAGES,
      tools: {
        lookup: tool({
          description: 'Looks something up.',
          inputSchema: z.object({ q: z.string() }),
          execute: async (): Promise<{ hit: string }> => {
            await sleep(5)
            throw new Error('upstream down')
          },
        }),
      },
      sink,
    })
    const call = result.meta.steps[0].toolCalls[0]
    expect(call.failed).toBe(true)
    expect(call.durationMs).toBeNumber()
    expect(
      sink.entries.some((e) => e.message.startsWith('lookup failed after')),
    ).toBe(true)
  })

  test('a streamed turn splits model time into waiting, reasoning and writing', async () => {
    const chunks: MockStreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', delta: 'Hmm, ' },
      { type: 'reasoning-delta', id: 'r1', delta: 'let me think.' },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'The answer.' },
      { type: 'text-end', id: 't1' },
      {
        type: 'finish',
        finishReason: mockFinish('stop'),
        usage: mockUsage(10, 5),
      },
    ]
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks,
          initialDelayInMs: 0,
          chunkDelayInMs: 15,
        }),
      }),
    })
    const sink = capturingSink({ delta: () => {} })
    const result = await runAgentGeneration({
      model,
      modelId: 'mock',
      output: { kind: 'text' },
      maxTurns: 1,
      streamReasoning: false,
      streamToolCalls: false,
      systemPrompt: 'Answer.',
      messages: MESSAGES,
      tools: {},
      sink,
    })
    const turn = result.meta.steps[0]
    expect(turn.firstOutputMs).toBeNumber()
    // Three chunk gaps sit between the first reasoning delta and the first text
    // delta (second reasoning delta, reasoning-end, text-start).
    expect(turn.reasoningMs).toBeGreaterThanOrEqual(3 * 15 - 10)
    expect(turn.modelMs).toBeGreaterThanOrEqual(
      turn.firstOutputMs! + turn.reasoningMs!,
    )
    // The thinking line is stamped with when the reasoning ended — before the
    // turn did.
    const thinking = sink.entries.find((e) => e.level === 'thinking')!
    expect(thinking.ts).toBeLessThan(turn.startedAt! + turn.durationMs!)
  })
})

describe('createTurnClock', () => {
  function clockAt() {
    let t = 1_000
    const sink = capturingSink()
    const clock = createTurnClock({
      streamToolCalls: true,
      toolStatusLabels: { search: 'Searching ${q}' },
      sink,
      now: () => t,
    })
    return {
      clock,
      sink,
      advance: (ms: number) => {
        t += ms
      },
    }
  }
  const call = { toolCallId: 'a', toolName: 'search', input: { q: 'x' } }

  test('two parallel tools: per-call durations kept, toolMs is wall time', () => {
    const { clock, advance } = clockAt()
    clock.callbacks.onStepStart()
    clock.callbacks.onLanguageModelCallStart()
    advance(100)
    clock.callbacks.onLanguageModelCallEnd()
    clock.callbacks.onToolExecutionStart({ toolCall: call })
    advance(10)
    clock.callbacks.onToolExecutionStart({
      toolCall: { ...call, toolCallId: 'b' },
    })
    advance(30)
    clock.callbacks.onToolExecutionEnd({
      toolCall: { ...call, toolCallId: 'b' },
      toolOutput: { type: 'tool-result' },
    })
    advance(20)
    clock.callbacks.onToolExecutionEnd({
      toolCall: call,
      toolOutput: { type: 'tool-result' },
    })
    expect(clock.toolTiming('a')).toEqual({
      startedAt: 1_100,
      finishedAt: 1_160,
      durationMs: 60,
    })
    expect(clock.toolTiming('b')?.durationMs).toBe(30)
    // Sum of calls is 90; the phase took 60.
    expect(clock.takeTurn(['a', 'b'])).toEqual({
      startedAt: 1_000,
      durationMs: 160,
      modelMs: 100,
      toolMs: 60,
    })
  })

  test('announces the user-facing status line live, stamped at the start', () => {
    const { clock, sink, advance } = clockAt()
    clock.callbacks.onStepStart()
    advance(5)
    clock.callbacks.onToolExecutionStart({ toolCall: call })
    expect(clock.announced('a')).toBe(true)
    expect(sink.entries.filter((e) => e.level === 'progress')).toEqual([
      {
        ts: 1_005,
        level: 'progress',
        message: 'Searching x',
        meta: { progress: 'tool', tool: 'search' },
      },
    ])
  })

  test('a turn that was never opened yields no timing', () => {
    const { clock } = clockAt()
    expect(clock.takeTurn([])).toEqual({})
  })
})

describe('turnTiming', () => {
  test('reasoning that ended the call runs to the end of the model call', () => {
    expect(
      turnTiming({
        notes: {
          startedAt: 0,
          modelStartedAt: 0,
          firstOutputAt: 50,
          firstReasoningAt: 50,
          modelEndedAt: 400,
        },
        endedAt: 400,
        tools: [],
      }),
    ).toEqual({
      startedAt: 0,
      durationMs: 400,
      modelMs: 400,
      firstOutputMs: 50,
      reasoningMs: 350,
    })
  })

  test('reasoning that arrives after the answer began is not counted', () => {
    const t = turnTiming({
      notes: {
        startedAt: 0,
        firstOutputAt: 10,
        firstNonReasoningAt: 10,
        firstReasoningAt: 90,
        modelEndedAt: 100,
      },
      endedAt: 100,
      tools: [],
    })
    expect(t.reasoningMs).toBeUndefined()
  })
})
