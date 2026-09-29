import type { LanguageModel, StepResult, ToolSet } from 'ai'
import { describe, expect, test } from 'bun:test'

import type { RunLogEntry, StreamSink } from '../stream-sink'

import {
  createLoopState,
  createOnStepFinish,
  createPrepareStep,
  type AgentLoopState,
} from './agent-generation-turn'

// The two seams the AI SDK hands the tool loop. Previously these were 200 lines
// nested inside `runToolLoop` and reachable only by driving a whole generation
// against a mock provider, which is why the four-rule precedence below — the part
// that decides when an agent stops researching and writes its answer — had no
// test of its own.

const ANSWERING = { answering: true } as unknown as LanguageModel

function capturingSink(): { sink: StreamSink; entries: RunLogEntry[] } {
  const entries: RunLogEntry[] = []
  return {
    sink: {
      log: (e) => {
        entries.push(e)
      },
    },
    entries,
  }
}

function policy(over: Partial<Parameters<typeof createPrepareStep>[0]> = {}) {
  const state = createLoopState()
  const { sink, entries } = capturingSink()
  const prepareStep = createPrepareStep({
    state,
    modelId: 'test-model',
    maxTurns: 5,
    answeringModel: ANSWERING,
    hasTools: true,
    sink,
    ...over,
  })
  return { state, entries, prepareStep }
}

/** The shape `onStepFinish` reads off a finished turn. */
function finishedStep(over: Partial<StepResult<ToolSet>> = {}) {
  return {
    stepNumber: 0,
    finishReason: 'stop',
    text: 'answer',
    toolCalls: [],
    toolResults: [],
    usage: { inputTokens: 100, outputTokens: 10 },
    ...over,
  } as unknown as StepResult<ToolSet>
}

describe('createPrepareStep — the ordinary turn', () => {
  test('leaves a mid-loop turn free to call tools or answer', () => {
    const { prepareStep, state } = policy()
    expect(prepareStep({ stepNumber: 1 })).toEqual({})
    expect(state.stepMustAnswer).toBe(false)
  })

  test('an agent with no tools must always answer', () => {
    const { prepareStep, state } = policy({ hasTools: false })
    // No `toolChoice` is imposed — there is nothing to deny — but the loop is
    // told this step answers, which is what lets its deltas stream.
    expect(prepareStep({ stepNumber: 1 })).toEqual({})
    expect(state.stepMustAnswer).toBe(true)
  })

  test('re-decides per turn rather than latching', () => {
    const { prepareStep, state } = policy({ maxTurns: 3 })
    prepareStep({ stepNumber: 2 })
    expect(state.stepMustAnswer).toBe(true)
    prepareStep({ stepNumber: 1 })
    expect(state.stepMustAnswer).toBe(false)
  })
})

describe('createPrepareStep — rule 1, out of turns', () => {
  test('denies tools on the final turn and swaps in the answering model', () => {
    const { prepareStep, state, entries } = policy({ maxTurns: 3 })
    expect(prepareStep({ stepNumber: 2 })).toEqual({
      toolChoice: 'none',
      model: ANSWERING,
    })
    expect(state.stepMustAnswer).toBe(true)
    expect(entries[0]?.message).toContain('turn 3/3, answering — no more tools')
  })

  test('maxTurns: 1 makes the very first turn the answering turn', () => {
    const { prepareStep } = policy({ maxTurns: 1 })
    expect(prepareStep({ stepNumber: 0 })).toEqual({
      toolChoice: 'none',
      model: ANSWERING,
    })
  })

  test('beats requireToolFirstTurn — the deny rules are never overridden', () => {
    // A forced tool call on a turn with no room to answer with the result is the
    // empty-answer run rule 1 exists to prevent.
    const { prepareStep } = policy({ maxTurns: 1, requireToolFirstTurn: true })
    expect(prepareStep({ stepNumber: 0 }).toolChoice).toBe('none')
  })
})

describe('createPrepareStep — rule 2, out of context window', () => {
  const window = { contextLength: 1000, answerReservePercent: 10 }

  test('stands down until a turn has reported its occupancy', () => {
    const { prepareStep, state } = policy(window)
    expect(prepareStep({ stepNumber: 1 })).toEqual({})
    expect(state.stoppedOnContextLimit).toBe(false)
  })

  test('stands down entirely when no window was reported', () => {
    const { prepareStep, state } = policy()
    state.lastInputTokens = 10_000_000
    expect(prepareStep({ stepNumber: 1 })).toEqual({})
    expect(state.stoppedOnContextLimit).toBe(false)
  })

  test('with no growth sample yet, assumes the conversation could double', () => {
    // 600 + 600 (pessimistic growth) + 100 reserve > 1000 → stop.
    const { prepareStep, state, entries } = policy(window)
    state.lastInputTokens = 600
    expect(prepareStep({ stepNumber: 1 })).toEqual({
      toolChoice: 'none',
      model: ANSWERING,
    })
    expect(state.stoppedOnContextLimit).toBe(true)
    expect(entries[0]?.meta).toMatchObject({
      lastInputTokens: 600,
      observedGrowth: 600,
      projected: 1200,
      answerReserveTokens: 100,
    })
  })

  test('a measured growth lets an agent ride much closer to the window', () => {
    // Same 600 tokens in flight, but the observed jump is only 50, so
    // 600 + 50 + 100 fits and there is room for another research turn.
    const { prepareStep, state } = policy(window)
    state.lastInputTokens = 600
    state.observedGrowth = 50
    expect(prepareStep({ stepNumber: 1 })).toEqual({})
    expect(state.stoppedOnContextLimit).toBe(false)
  })

  test('stops once the measured growth would not leave the answer reserve', () => {
    // 600 + 350 + 100 > 1000.
    const { prepareStep, state } = policy(window)
    state.lastInputTokens = 600
    state.observedGrowth = 350
    expect(prepareStep({ stepNumber: 1 }).toolChoice).toBe('none')
    expect(state.stoppedOnContextLimit).toBe(true)
  })

  test('is checked BEFORE the spend budget — the window is a hard error', () => {
    const { prepareStep, state } = policy({ ...window, toolTokenBudget: 1 })
    state.lastInputTokens = 600
    state.totalUsage.inputTokens = 5000
    prepareStep({ stepNumber: 1 })
    expect(state.stoppedOnContextLimit).toBe(true)
    expect(state.stoppedOnTokenBudget).toBe(false)
  })

  test('a bigger reserve stops sooner', () => {
    // 500 + 50 + 500 > 1000 stops, where the default 10% reserve would have
    // allowed it (500 + 50 + 100 = 650).
    const state = createLoopState()
    state.lastInputTokens = 500
    state.observedGrowth = 50
    const args = {
      state,
      modelId: 'm',
      maxTurns: 5,
      answeringModel: ANSWERING,
      hasTools: true,
      contextLength: 1000,
    }
    expect(createPrepareStep(args)({ stepNumber: 1 })).toEqual({})
    expect(
      createPrepareStep({ ...args, answerReservePercent: 50 })({ stepNumber: 1 })
        .toolChoice,
    ).toBe('none')
  })
})

describe('createPrepareStep — rule 3, out of spend budget', () => {
  test('denies tools once the ceiling is reached, and says what it spent', () => {
    const { prepareStep, state, entries } = policy({ toolTokenBudget: 500 })
    state.totalUsage.inputTokens = 400
    state.totalUsage.outputTokens = 100
    expect(prepareStep({ stepNumber: 1 })).toEqual({
      toolChoice: 'none',
      model: ANSWERING,
    })
    expect(state.stoppedOnTokenBudget).toBe(true)
    expect(entries[0]?.message).toContain('token budget reached at 500')
    expect(entries[0]?.meta).toMatchObject({ spent: 500, toolTokenBudget: 500 })
  })

  test('counts input AND output against the ceiling', () => {
    const { prepareStep, state } = policy({ toolTokenBudget: 500 })
    state.totalUsage.inputTokens = 400
    state.totalUsage.outputTokens = 99
    expect(prepareStep({ stepNumber: 1 })).toEqual({})
    expect(state.stoppedOnTokenBudget).toBe(false)
  })

  test('no ceiling configured means no ceiling', () => {
    const { prepareStep, state } = policy({ toolTokenBudget: null })
    state.totalUsage.inputTokens = 10_000_000
    expect(prepareStep({ stepNumber: 1 })).toEqual({})
    expect(state.stoppedOnTokenBudget).toBe(false)
  })
})

describe('createPrepareStep — rule 4, requireToolFirstTurn', () => {
  test('demands a tool call on turn 1 only', () => {
    const { prepareStep, entries } = policy({ requireToolFirstTurn: true })
    expect(prepareStep({ stepNumber: 0 })).toEqual({ toolChoice: 'required' })
    expect(entries[0]?.message).toContain('turn 1/5, tool call required')
    // Turn 2 is free to answer, so the loop can't be trapped.
    expect(prepareStep({ stepNumber: 1 })).toEqual({})
  })

  test('is inert with no tool to call', () => {
    const { prepareStep } = policy({ requireToolFirstTurn: true, hasTools: false })
    expect(prepareStep({ stepNumber: 0 })).toEqual({})
  })
})

describe('createOnStepFinish — tracing', () => {
  test('records the turn and accumulates usage', () => {
    const state = createLoopState()
    const onStepFinish = createOnStepFinish({
      state,
      modelId: 'test-model',
      maxTurns: 5,
      streamReasoning: false,
      streamToolCalls: false,
    })
    onStepFinish(finishedStep())
    onStepFinish(
      finishedStep({
        stepNumber: 1,
        usage: { inputTokens: 250, outputTokens: 20 },
      } as Partial<StepResult<ToolSet>>),
    )
    expect(state.stepTraces.map((s) => s.stepNumber)).toEqual([0, 1])
    expect(state.totalUsage).toEqual({ inputTokens: 350, outputTokens: 30 })
  })

  test('pairs each tool call with its result', () => {
    const state = createLoopState()
    const onStepFinish = createOnStepFinish({
      state,
      modelId: 'm',
      maxTurns: 5,
      streamReasoning: false,
      streamToolCalls: false,
    })
    onStepFinish(
      finishedStep({
        toolCalls: [
          { toolCallId: 'a', toolName: 'search', input: { q: 'x' } },
          { toolCallId: 'b', toolName: 'read', input: { id: 1 } },
        ],
        // Deliberately out of order, and missing one — the pairing is by id, and
        // a call with no result records `null` rather than dropping the call.
        toolResults: [{ toolCallId: 'b', output: 'read-output' }],
      } as unknown as Partial<StepResult<ToolSet>>),
    )
    expect(state.stepTraces[0].toolCalls).toEqual([
      { toolCallId: 'a', toolName: 'search', input: { q: 'x' }, output: null },
      { toolCallId: 'b', toolName: 'read', input: { id: 1 }, output: 'read-output' },
    ])
  })

  test('tracks occupancy as the LAST turn and growth as the LARGEST jump', () => {
    const state = createLoopState()
    const onStepFinish = createOnStepFinish({
      state,
      modelId: 'm',
      maxTurns: 5,
      streamReasoning: false,
      streamToolCalls: false,
    })
    for (const inputTokens of [100, 900, 1000]) {
      onStepFinish(
        finishedStep({ usage: { inputTokens, outputTokens: 1 } } as Partial<
          StepResult<ToolSet>
        >),
      )
    }
    expect(state.lastInputTokens).toBe(1000)
    // 800 then 100 — the fat tool result is what the guard has to survive.
    expect(state.observedGrowth).toBe(800)
  })

  test('the first turn establishes occupancy without inventing a growth sample', () => {
    const state = createLoopState()
    createOnStepFinish({
      state,
      modelId: 'm',
      maxTurns: 5,
      streamReasoning: false,
      streamToolCalls: false,
    })(finishedStep())
    expect(state.lastInputTokens).toBe(100)
    expect(state.observedGrowth).toBe(0)
  })
})

describe('createOnStepFinish — the two feeds', () => {
  function trace(over: Partial<Parameters<typeof createOnStepFinish>[0]>) {
    const state: AgentLoopState = createLoopState()
    const { sink, entries } = capturingSink()
    return {
      entries,
      onStepFinish: createOnStepFinish({
        state,
        modelId: 'm',
        maxTurns: 5,
        streamReasoning: false,
        streamToolCalls: false,
        sink,
        ...over,
      }),
    }
  }
  const withReasoningAndTool = finishedStep({
    reasoningText: '  thinking hard  ',
    toolCalls: [{ toolCallId: 'a', toolName: 'search', input: { q: 'x' } }],
  } as unknown as Partial<StepResult<ToolSet>>)

  test('the dev feed is unconditional', () => {
    const { onStepFinish, entries } = trace({})
    onStepFinish(withReasoningAndTool)
    expect(entries.filter((e) => e.level === 'thinking')).toEqual([
      { level: 'thinking', message: 'thinking hard' },
    ])
    expect(entries.filter((e) => e.level === 'tool')).toHaveLength(1)
    // …and with both user toggles off, nothing reaches the user.
    expect(entries.filter((e) => e.level === 'progress')).toEqual([])
  })

  test('streamReasoning mirrors reasoning to the user, tagged as reasoning', () => {
    const { onStepFinish, entries } = trace({ streamReasoning: true })
    onStepFinish(withReasoningAndTool)
    expect(entries.filter((e) => e.level === 'progress')).toEqual([
      {
        level: 'progress',
        message: 'thinking hard',
        meta: { progress: 'reasoning' },
      },
    ])
  })

  test('streamToolCalls announces only tools that have a status template', () => {
    const { onStepFinish, entries } = trace({
      streamToolCalls: true,
      toolStatusLabels: { search: 'Searching for ${q}' },
    })
    onStepFinish(
      finishedStep({
        toolCalls: [
          { toolCallId: 'a', toolName: 'search', input: { q: 'contracts' } },
          { toolCallId: 'b', toolName: 'read', input: { id: 1 } },
        ],
      } as unknown as Partial<StepResult<ToolSet>>),
    )
    expect(entries.filter((e) => e.level === 'progress')).toEqual([
      {
        level: 'progress',
        message: 'Searching for contracts',
        meta: { progress: 'tool', tool: 'search' },
      },
    ])
  })

  test('a template that interpolates to nothing stays silent', () => {
    const { onStepFinish, entries } = trace({
      streamToolCalls: true,
      toolStatusLabels: { search: '${missing}' },
    })
    onStepFinish(withReasoningAndTool)
    expect(entries.filter((e) => e.level === 'progress')).toEqual([])
  })

  test('marks the gap before the next round-trip when a turn called tools', () => {
    const { onStepFinish, entries } = trace({})
    onStepFinish(withReasoningAndTool)
    expect(entries.at(-1)).toEqual({
      level: 'info',
      message: '→ m (turn 2/5)',
    })
  })

  test('does not promise a next round-trip from the final turn', () => {
    const { onStepFinish, entries } = trace({})
    onStepFinish(
      finishedStep({
        stepNumber: 4,
        toolCalls: [{ toolCallId: 'a', toolName: 'search', input: {} }],
      } as unknown as Partial<StepResult<ToolSet>>),
    )
    expect(entries.filter((e) => e.level === 'info')).toEqual([])
  })

  test('a turn that called nothing gets no boundary line', () => {
    const { onStepFinish, entries } = trace({})
    onStepFinish(finishedStep())
    expect(entries.filter((e) => e.level === 'info')).toEqual([])
  })

  test('still records the turn with no sink at all', () => {
    const state = createLoopState()
    createOnStepFinish({
      state,
      modelId: 'm',
      maxTurns: 5,
      streamReasoning: true,
      streamToolCalls: true,
    })(withReasoningAndTool)
    expect(state.stepTraces).toHaveLength(1)
    expect(state.totalUsage.inputTokens).toBe(100)
  })
})
