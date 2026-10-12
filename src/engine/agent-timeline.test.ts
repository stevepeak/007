import { describe, expect, test } from 'bun:test'

import {
  agentTimeline,
  agentTimingSpans,
  agentTimingSummary,
  describeSlowest,
  modelSegments,
} from './agent-timeline'
import type { AgentNodeMeta } from './nodes/agent-generation-types'

// The shape every reader of an agent step's timing shares: the run viewer's
// waterfall, the trace exporter's child spans, and the MCP summary.

const T0 = 1_700_000_000_000

function meta(steps: AgentNodeMeta['steps']): AgentNodeMeta {
  return {
    model: 'm',
    systemPrompt: '',
    steps,
    totalUsage: { inputTokens: 0, outputTokens: 0 },
  }
}

// Turn 1: 10s, a streamed model call (1s waiting, 6s thinking, 1s writing),
// then two parallel tools. Turn 2: 3s, unstreamed, no tools.
const TIMED = meta([
  {
    stepNumber: 0,
    startedAt: T0,
    durationMs: 10_000,
    modelMs: 8_000,
    firstOutputMs: 1_000,
    reasoningMs: 6_000,
    toolMs: 2_000,
    toolCalls: [
      {
        toolCallId: 'a',
        toolName: 'web_search',
        input: {},
        output: {},
        startedAt: T0 + 8_000,
        finishedAt: T0 + 10_000,
        durationMs: 2_000,
      },
      {
        toolCallId: 'b',
        toolName: 'kb_search',
        input: {},
        output: {},
        startedAt: T0 + 8_000,
        finishedAt: T0 + 8_500,
        durationMs: 500,
        failed: true,
      },
    ],
  },
  {
    stepNumber: 1,
    startedAt: T0 + 10_000,
    durationMs: 3_000,
    modelMs: 3_000,
    toolCalls: [],
  },
])

describe('modelSegments', () => {
  test('a streamed call splits into waiting, thinking, generating', () => {
    expect(
      modelSegments({
        modelMs: 8_000,
        firstOutputMs: 1_000,
        reasoningMs: 6_000,
      }),
    ).toEqual([
      { kind: 'waiting', startMs: 0, endMs: 1_000 },
      { kind: 'thinking', startMs: 1_000, endMs: 7_000 },
      { kind: 'generating', startMs: 7_000, endMs: 8_000 },
    ])
  })

  test('an unstreamed call is one undivided model segment', () => {
    expect(modelSegments({ modelMs: 500 })).toEqual([
      { kind: 'model', startMs: 0, endMs: 500 },
    ])
  })

  test('phases are clamped inside the model call', () => {
    expect(
      modelSegments({ modelMs: 100, firstOutputMs: 80, reasoningMs: 500 }),
    ).toEqual([
      { kind: 'waiting', startMs: 0, endMs: 80 },
      { kind: 'thinking', startMs: 80, endMs: 100 },
    ])
  })

  test('no model time, no segments', () => {
    expect(modelSegments({})).toEqual([])
  })
})

describe('agentTimeline', () => {
  test('a step recorded before timing existed has no timeline', () => {
    expect(
      agentTimeline(
        meta([
          {
            stepNumber: 0,
            toolCalls: [
              { toolCallId: 'a', toolName: 't', input: 1, output: 2 },
            ],
          },
        ]),
      ),
    ).toBeNull()
    expect(agentTimeline(null)).toBeNull()
    expect(agentTimeline({ items: [] })).toBeNull()
  })

  test('lays turns, phases and tool calls on one axis', () => {
    const tl = agentTimeline(TIMED)!
    expect(tl.originAt).toBe(T0)
    expect(tl.totalMs).toBe(13_000)
    expect(tl.turns.map((t) => [t.startMs, t.endMs])).toEqual([
      [0, 10_000],
      [10_000, 13_000],
    ])
    expect(tl.turns[0].segments.map((s) => s.kind)).toEqual([
      'waiting',
      'thinking',
      'generating',
      'tools',
    ])
    expect(tl.turns[0].segments.at(-1)).toEqual({
      kind: 'tools',
      startMs: 8_000,
      endMs: 10_000,
    })
    expect(tl.turns[0].toolCalls[1]).toEqual({
      toolCallId: 'b',
      toolName: 'kb_search',
      failed: true,
      startMs: 8_000,
      endMs: 8_500,
    })
    // Turn 2's model segment is offset to where the turn began.
    expect(tl.turns[1].segments).toEqual([
      { kind: 'model', startMs: 10_000, endMs: 13_000 },
    ])
  })

  test('names the slowest segment and its share of the step', () => {
    const tl = agentTimeline(TIMED)!
    expect(tl.slowest).toEqual({
      turnIndex: 0,
      kind: 'thinking',
      ms: 6_000,
      share: 6_000 / 13_000,
    })
    expect(describeSlowest(tl.slowest!)).toBe(
      '46% of this step was model reasoning on turn 1',
    )
  })

  test('a slow tool phase names its slowest call', () => {
    const tl = agentTimeline(
      meta([
        {
          stepNumber: 0,
          startedAt: T0,
          durationMs: 5_000,
          modelMs: 1_000,
          toolMs: 4_000,
          toolCalls: [
            {
              toolCallId: 'a',
              toolName: 'web_search',
              input: {},
              output: {},
              startedAt: T0 + 1_000,
              finishedAt: T0 + 5_000,
            },
          ],
        },
      ]),
    )!
    expect(describeSlowest(tl.slowest!)).toBe(
      '80% of this step was running tools (slowest call: web_search, 4.0s) on turn 1',
    )
  })

  test('only timed turns are laid out when timing is partial', () => {
    const tl = agentTimeline(
      meta([
        { stepNumber: 0, toolCalls: [] },
        {
          stepNumber: 1,
          startedAt: T0,
          durationMs: 100,
          modelMs: 100,
          toolCalls: [],
        },
      ]),
    )!
    expect(tl.turns.map((t) => t.index)).toEqual([1])
  })
})

describe('agentTimingSpans', () => {
  test('one turn span per timed turn, holding its tool-call spans', () => {
    const spans = agentTimingSpans(TIMED)
    expect(spans.map((s) => [s.op, s.name, s.startAt, s.endAt])).toEqual([
      ['wf.agent.turn', 'Turn 1 of 2', T0, T0 + 10_000],
      ['wf.agent.turn', 'Turn 2 of 2', T0 + 10_000, T0 + 13_000],
    ])
    expect(spans[0].attributes).toMatchObject({
      'wf.model_ms': 8_000,
      'wf.reasoning_ms': 6_000,
      'wf.tool_ms': 2_000,
    })
    expect(spans[0].children.map((c) => [c.op, c.name])).toEqual([
      ['wf.tool.call', 'web_search'],
      ['wf.tool.call', 'kb_search'],
    ])
    expect(spans[0].children[1].attributes).toMatchObject({
      'wf.tool_id': 'kb_search',
      'wf.duration_ms': 500,
      'wf.tool_failed': true,
    })
  })

  test('nothing for untimed or non-agent meta', () => {
    expect(agentTimingSpans(meta([{ stepNumber: 0, toolCalls: [] }]))).toEqual(
      [],
    )
    expect(agentTimingSpans(undefined)).toEqual([])
  })
})

describe('agentTimingSummary', () => {
  test('a compact per-turn account with the headline', () => {
    const s = agentTimingSummary(TIMED)!
    expect(s.totalMs).toBe(13_000)
    expect(s.slowest).toBe('46% of this step was model reasoning on turn 1')
    expect(s.turns[0]).toEqual({
      turn: 1,
      durationMs: 10_000,
      modelMs: 8_000,
      reasoningMs: 6_000,
      firstOutputMs: 1_000,
      toolMs: 2_000,
      toolCalls: [
        { tool: 'web_search', durationMs: 2_000 },
        { tool: 'kb_search', durationMs: 500, failed: true },
      ],
    })
  })

  test('null when there is no timing', () => {
    expect(agentTimingSummary(meta([]))).toBeNull()
  })
})
