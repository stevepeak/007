import { describe, expect, test } from 'bun:test'

import type { AgentNode } from '../engine/graph'
import type { AgentNodeMeta } from '../engine/nodes/agent'

import {
  agentStepsOf,
  draftSampleFromRun,
  recoverTaskVariables,
  recoverTurns,
  type RunDraftStep,
} from './from-run'

/**
 * The conversion from a trace to a Sample. What matters here is not that it
 * produces *a* sample but that it produces a sample that GRADES SOMETHING: the
 * fixtures have to be keyed the way the grader looks them up, the staged
 * conversation has to stop before the reply being graded, and a run a human
 * called bad must never have its own answer seeded as the standard.
 */

function step(over: Partial<RunDraftStep>): RunDraftStep {
  return {
    cursor: 1,
    nodeId: 'n1',
    nodeKind: 'agent',
    parentNodeId: null,
    itemIndex: null,
    input: {},
    output: {},
    meta: undefined,
    ...over,
  }
}

function agentMeta(over: Partial<AgentNodeMeta>): AgentNodeMeta {
  return {
    model: 'venice/x',
    systemPrompt: 'be helpful',
    totalUsage: { inputTokens: 1, outputTokens: 1 },
    steps: [],
    ...over,
  }
}

const searched = agentMeta({
  agentId: 'ag_1',
  agentVersion: 4,
  messages: [
    { role: 'user', text: 'Do we have a conflict with Acme?' },
    { role: 'assistant', text: 'No conflict found.' },
  ],
  steps: [
    {
      stepNumber: 1,
      toolCalls: [
        {
          toolCallId: 't1',
          toolName: 'search_rag',
          input: { q: 'Acme' },
          output: { chunks: ['nothing on file'] },
        },
      ],
    },
  ],
})

const conversationTarget = {
  inputKind: 'conversation' as const,
  inputVariables: [],
}

describe('agentStepsOf', () => {
  test('lists each agent step with what it needs to be chosen between', () => {
    const steps = [
      step({ cursor: 1, nodeKind: 'trigger' }),
      step({ cursor: 2, nodeId: 'a', meta: searched }),
      step({ cursor: 3, nodeId: 'b', meta: agentMeta({ agentId: 'ag_2' }) }),
    ]
    expect(agentStepsOf(steps)).toEqual([
      {
        cursor: 2,
        nodeId: 'a',
        agentId: 'ag_1',
        agentVersion: 4,
        model: 'venice/x',
        toolCallCount: 1,
      },
      {
        cursor: 3,
        nodeId: 'b',
        agentId: 'ag_2',
        agentVersion: null,
        model: 'venice/x',
        toolCallCount: 0,
      },
    ])
  })
})

describe('recoverTaskVariables', () => {
  const node = {
    id: 'n1',
    kind: 'agent',
    config: {
      agentId: 'ag_1',
      inputs: {
        matterName: { kind: 'literal', value: 'Acme v. Bex' },
        summary: { kind: 'ref', nodeId: 'n0', path: 'doc.title' },
      },
    },
  } as unknown as AgentNode

  const steps = [
    step({ cursor: 0, nodeId: 'n0', output: { doc: { title: 'Lease' } } }),
    step({ cursor: 1, nodeId: 'n1' }),
  ]

  test('resolves literal and ref bindings against the recorded outputs', () => {
    expect(
      recoverTaskVariables(node, steps[1], steps, ['matterName', 'summary']),
    ).toEqual({ matterName: 'Acme v. Bex', summary: 'Lease' })
  })

  test('leaves a run-level variable absent rather than inventing one', () => {
    // Run-level promptVariables aren't persisted per step; a blank string would
    // look filled and render literally into the prompt.
    const out = recoverTaskVariables(node, steps[1], steps, ['tone'])
    expect('tone' in out).toBe(false)
  })

  test('falls back to a matching field on the routed input', () => {
    const s = step({ cursor: 1, nodeId: 'n1', input: { tone: 'formal' } })
    expect(recoverTaskVariables(node, s, [s], ['tone'])).toEqual({
      tone: 'formal',
    })
  })

  test('a free-form agent captures the routed input instead of nothing', () => {
    const s = step({ input: { a: 1, b: 'two' } })
    expect(recoverTaskVariables(null, s, [s], [])).toEqual({ a: '1', b: 'two' })
  })

  test('prefers a sibling inside the same iteration item', () => {
    const inIteration = [
      step({ cursor: 0, nodeId: 'n0', output: { doc: { title: 'TOP' } } }),
      step({
        cursor: 1,
        nodeId: 'n0',
        parentNodeId: 'loop',
        itemIndex: 2,
        output: { doc: { title: 'ITEM 2' } },
      }),
      step({ cursor: 2, nodeId: 'n1', parentNodeId: 'loop', itemIndex: 2 }),
    ]
    expect(
      recoverTaskVariables(node, inIteration[2], inIteration, ['summary']),
    ).toEqual({ summary: 'ITEM 2' })
  })
})

describe('recoverTurns', () => {
  // The Sample stages the thread up to where the reply is due; the reply is what
  // the run will produce and the checks will grade.
  test('drops the trailing assistant turn being graded', () => {
    expect(recoverTurns(searched)).toEqual([
      { role: 'user', text: 'Do we have a conflict with Acme?' },
    ])
  })

  test('is empty for a step recorded before messages were captured', () => {
    expect(recoverTurns(agentMeta({}))).toEqual([])
  })
})

describe('draftSampleFromRun — trajectory', () => {
  const drafted = draftSampleFromRun({
    step: step({ meta: searched }),
    steps: [step({ meta: searched })],
    node: null,
    target: conversationTarget,
    layer: 'trajectory',
  })

  test('keys fixtures on the tool id the grader looks them up under', () => {
    // `meta.toolCalls[].toolName` is the ToolSet key; a fixture keyed any other
    // way is silently never used and the sample runs against an empty result.
    if ('error' in drafted) throw new Error(drafted.error)
    expect(drafted.tools).toEqual({
      mode: 'mocked',
      fixtures: { search_rag: { chunks: ['nothing on file'] } },
    })
  })

  test('asserts the tools the run really called', () => {
    if ('error' in drafted) throw new Error(drafted.error)
    expect(drafted.checks.checks[0]).toEqual({
      type: 'tool_called',
      toolId: 'search_rag',
      called: true,
    })
  })

  test('truncates a fixture too large to inline, and says which', () => {
    const fat = agentMeta({
      steps: [
        {
          stepNumber: 1,
          toolCalls: [
            {
              toolCallId: 't',
              toolName: 'fetch_doc',
              input: {},
              output: { body: 'x'.repeat(5000) },
            },
          ],
        },
      ],
    })
    const out = draftSampleFromRun({
      step: step({ meta: fat }),
      steps: [],
      node: null,
      target: conversationTarget,
      layer: 'trajectory',
      maxFixtureChars: 500,
    })
    if ('error' in out) throw new Error(out.error)
    const fixtures = (out.tools as { fixtures: Record<string, unknown> })
      .fixtures
    expect(String(fixtures.fetch_doc)).toContain('truncated')
    expect(out.notes.join(' ')).toContain('fetch_doc')
  })

  test('keeps one fixture per tool and says the last call won', () => {
    const twice = agentMeta({
      steps: [
        {
          stepNumber: 1,
          toolCalls: [
            { toolCallId: 'a', toolName: 'search_rag', input: {}, output: 1 },
            { toolCallId: 'b', toolName: 'search_rag', input: {}, output: 2 },
          ],
        },
      ],
    })
    const out = draftSampleFromRun({
      step: step({ meta: twice }),
      steps: [],
      node: null,
      target: conversationTarget,
      layer: 'trajectory',
    })
    if ('error' in out) throw new Error(out.error)
    expect(out.tools).toEqual({ mode: 'mocked', fixtures: { search_rag: 2 } })
    expect(out.notes.join(' ')).toContain('called more than once')
  })
})

describe('draftSampleFromRun — synthesis', () => {
  test('stages the retrieval as an assistant turn and freezes the tools', () => {
    const out = draftSampleFromRun({
      step: step({ meta: searched }),
      steps: [],
      node: null,
      target: conversationTarget,
      layer: 'synthesis',
    })
    if ('error' in out) throw new Error(out.error)
    expect(out.tools).toEqual({ mode: 'frozen' })
    const turns = (out.input as { turns: unknown[] }).turns
    expect(turns).toEqual([
      { role: 'user', text: 'Do we have a conflict with Acme?' },
      {
        role: 'assistant',
        toolCalls: [
          {
            tool: 'search_rag',
            args: { q: 'Acme' },
            output: { chunks: ['nothing on file'] },
          },
        ],
      },
    ])
  })

  test('declares no trajectory check it could never satisfy', () => {
    const out = draftSampleFromRun({
      step: step({ meta: searched }),
      steps: [],
      node: null,
      target: conversationTarget,
      layer: 'synthesis',
    })
    if ('error' in out) throw new Error(out.error)
    // Frozen tools mean the agent calls nothing, so a `tool_called` check here
    // would grade an absence and fail every time.
    expect(out.checks.checks.map((c) => c.type)).toEqual(['llm_judge'])
  })

  // Synthesis has to stage the context in a thread, and a task agent has none.
  test('refuses a task agent rather than degrading into a plain io test', () => {
    const out = draftSampleFromRun({
      step: step({ meta: searched }),
      steps: [],
      node: null,
      target: { inputKind: 'task', inputVariables: [] },
      layer: 'synthesis',
    })
    expect('error' in out && out.error).toContain('trajectory')
  })
})

describe('the seeded rubric', () => {
  function rubricFor(feedback: { rating: string; note: string | null } | null) {
    const out = draftSampleFromRun({
      step: step({ meta: searched }),
      steps: [],
      node: null,
      target: conversationTarget,
      layer: 'trajectory',
      feedback,
    })
    if ('error' in out) throw new Error(out.error)
    const judge = out.checks.checks.find((c) => c.type === 'llm_judge')
    return { rubric: (judge as { rubric: string }).rubric, notes: out.notes }
  }

  test('says out loud that it is unfinished', () => {
    expect(rubricFor(null).rubric).toStartWith('TODO')
  })

  // The failure mode this guards: seeding a bad answer as the expected one turns
  // the sample into a test that the bug is still there.
  test('never treats a thumbs-down answer as the standard', () => {
    const { rubric, notes } = rubricFor({
      rating: 'down',
      note: 'It missed the Bex matter.',
    })
    expect(rubric).toContain('must FAIL this rubric')
    expect(rubric).toContain('It missed the Bex matter.')
    expect(notes.join(' ')).toContain('do not seed it as the expected output')
  })

  test('never asserts equality with the run output', () => {
    const out = draftSampleFromRun({
      step: step({ meta: searched, output: { text: 'No conflict found.' } }),
      steps: [],
      node: null,
      target: conversationTarget,
      layer: 'trajectory',
    })
    if ('error' in out) throw new Error(out.error)
    expect(JSON.stringify(out.checks)).not.toContain('No conflict found.')
    expect(out.checks.checks.map((c) => c.type)).not.toContain('output_match')
  })
})
