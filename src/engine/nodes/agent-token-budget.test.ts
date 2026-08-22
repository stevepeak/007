import { tool } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import { makeAgentConfig } from '../agent-test-helpers'
import type { AgentNode, WfRunManifestEntry } from '../graph'
import { mockFinish } from '../model-test-helpers'
import type { ToolRegistry } from '../tool-registry'

import { executeAgentNode } from './agent'

// `tokenBudget` bounds an agent by SPEND rather than by round-trips, and its
// whole reason for existing is the shape of the failure it replaces: the node's
// wall-clock guard aborts an overrunning agent, and that abort is fatal and
// never retried — money spent, nothing returned. Reaching the token ceiling
// instead ends the same investigation with a written answer.
//
// So the assertions that matter are: it stops tool-calling when the ceiling is
// crossed, the run still SUCCEEDS with real text, and it says so on the meta.

const AUTO = { type: 'auto' }

// Each mock turn below reports this much usage, so a ceiling is expressed in
// whole turns: 1000 tokens spent per completed turn.
const PER_TURN_TOKENS = 1000

// A mock speaks the PROVIDER-level protocol, whose usage is nested
// (`LanguageModelV3Usage`) — unlike the flat `step.usage` the core `ai` package
// hands `onStepFinish`. Getting this wrong doesn't fail loudly: the SDK maps no
// usage at all, `step.usage` arrives as `{}`, and every token-based assertion
// silently sees a budget that is never spent.
function usage (input: number, output: number) {
  return {
  inputTokens: {
    total: input,
    noCache: input,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: output, text: output, reasoning: undefined },
}
}

function MANIFEST (maxTurns: number,
  toolTokenBudget: number | null,
  contextLength?: number): WfRunManifestEntry[] {
  return [
  {
    kind: 'agent',
    id: 'bot',
    pinnedVersion: null,
    versionId: 'v1',
    versionNumber: 1,
    name: 'Researcher',
    ...(contextLength != null ? { contextLength } : {}),
    config: makeAgentConfig({
      modelId: 'mock',
      prompt: 'Research, then answer.',
      userPrompt: 'Go.',
      inputKind: 'task' as const,
      toolIds: ['lookup'],
      maxTurns,
      toolTokenBudget,
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

// The agent the budget exists for: it would research forever, spending a fixed
// amount per turn, and only writes an answer once tools are taken away.
function insatiableResearcher(seen: { toolChoices: unknown[] }) {
  let call = 0
  return new MockLanguageModelV3({
    doGenerate: async (opts) => {
      const choice = (opts as { toolChoice?: { type?: string } }).toolChoice
      seen.toolChoices.push(choice)
      const denied = choice?.type === 'none'
      call++
      return {
        content: denied
          ? [{ type: 'text' as const, text: 'Here is what I found.' }]
          : [
              {
                type: 'tool-call' as const,
                toolCallId: `c${call}`,
                toolName: 'lookup',
                input: JSON.stringify({ q: 'again' }),
              },
            ],
        finishReason: denied ? mockFinish('stop') : mockFinish('tool-calls'),
        usage: usage(PER_TURN_TOKENS / 2, PER_TURN_TOKENS / 2),
        warnings: [],
      }
    },
  })
}

function run (model: MockLanguageModelV3,
  manifest: WfRunManifestEntry[]) {
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

describe('agent node — toolTokenBudget', () => {
  test('crossing the budget forces the answer instead of failing the node', async () => {
    const seen: { toolChoices: unknown[] } = { toolChoices: [] }
    // Budget 5000, turns cost 1000 each: turns 1-5 research (5000 spent) and
    // turn 6 is over. maxTurns is 50 so the TURN limit can't be what stops it —
    // the budget has to be.
    const result = await run(insatiableResearcher(seen), MANIFEST(50, 5000))

    expect((result.output as { text: string }).text).toBe(
      'Here is what I found.',
    )
    // Five researching turns, then the budget takes the tools away.
    expect(seen.toolChoices).toEqual([
      AUTO,
      AUTO,
      AUTO,
      AUTO,
      AUTO,
      { type: 'none' },
    ])
  })

  test('the run is marked as cut short by the budget, not by turns', async () => {
    const seen: { toolChoices: unknown[] } = { toolChoices: [] }
    const result = await run(insatiableResearcher(seen), MANIFEST(50, 2000))

    // A reader comparing two runs of this agent needs to know one was truncated.
    expect(result.meta.stoppedOnTokenBudget).toBe(true)
    expect(result.meta.stoppedOnContextLimit).toBeUndefined()
    expect(result.meta.totalUsage.inputTokens).toBeGreaterThan(0)
  })

  test('the budget bounds RESEARCH — the answer is generated on top of it', async () => {
    const seen: { toolChoices: unknown[] } = { toolChoices: [] }
    const result = await run(insatiableResearcher(seen), MANIFEST(50, 2000))

    // Two turns of research reach the budget; the forced answering turn spends
    // another 1000 on top. This is why the editor states cost as a floor: the
    // budget is not a cap on what the run costs.
    const spent =
      result.meta.totalUsage.inputTokens + result.meta.totalUsage.outputTokens
    expect(spent).toBeGreaterThan(2000)
  })

  test('no budget set — only maxTurns bounds the loop, as before', async () => {
    const seen: { toolChoices: unknown[] } = { toolChoices: [] }
    const result = await run(insatiableResearcher(seen), MANIFEST(3, null))

    expect(seen.toolChoices).toEqual([AUTO, AUTO, { type: 'none' }])
    expect(result.meta.stoppedOnTokenBudget).toBeUndefined()
  })

  test('the turn limit still wins when it lands first', async () => {
    const seen: { toolChoices: unknown[] } = { toolChoices: [] }
    // A budget far too large to ever bite: maxTurns has to be what stops it, and
    // the run must NOT be attributed to the budget.
    const result = await run(
      insatiableResearcher(seen),
      MANIFEST(2, 10_000_000),
    )

    expect(seen.toolChoices).toEqual([AUTO, { type: 'none' }])
    expect(result.meta.stoppedOnTokenBudget).toBeUndefined()
  })

  test('a tiny budget stops on turn 1 and still produces an answer', async () => {
    const seen: { toolChoices: unknown[] } = { toolChoices: [] }
    // Budget below one turn's cost. Turn 1 has spent nothing yet so it
    // researches; turn 2 is already over. An over-tight budget degrades to "one
    // look, then answer", never to an empty result.
    const result = await run(insatiableResearcher(seen), MANIFEST(50, 1000))

    expect(seen.toolChoices).toEqual([AUTO, { type: 'none' }])
    expect((result.output as { text: string }).text).toBe(
      'Here is what I found.',
    )
  })
})

// The other half of the design: a guard nobody configures. Overflowing the
// model's window is a hard provider error, so the loop stops gathering on its
// own — no budget involved, and no setting to get wrong.
describe('agent node — context window guard', () => {
  test('stops gathering as the conversation approaches the window', async () => {
    const seen: { toolChoices: unknown[] } = { toolChoices: [] }
    // Each turn reports 500 input tokens, so occupancy sits at 500 from turn 1
    // onward. A 600-token window puts the 80% ceiling at 480 — already crossed.
    const result = await run(
      insatiableResearcher(seen),
      MANIFEST(50, null, 600),
    )

    expect(seen.toolChoices).toEqual([AUTO, { type: 'none' }])
    expect(result.meta.stoppedOnContextLimit).toBe(true)
    expect((result.output as { text: string }).text).toBe(
      'Here is what I found.',
    )
  })

  test('a roomy window never trips it', async () => {
    const seen: { toolChoices: unknown[] } = { toolChoices: [] }
    const result = await run(insatiableResearcher(seen), MANIFEST(3, null, 1e6))

    expect(seen.toolChoices).toEqual([AUTO, AUTO, { type: 'none' }])
    expect(result.meta.stoppedOnContextLimit).toBeUndefined()
  })

  test('no reported window — the guard stands down rather than guessing', async () => {
    const seen: { toolChoices: unknown[] } = { toolChoices: [] }
    const result = await run(insatiableResearcher(seen), MANIFEST(3, null))

    expect(seen.toolChoices).toEqual([AUTO, AUTO, { type: 'none' }])
    expect(result.meta.stoppedOnContextLimit).toBeUndefined()
  })

  test('the window wins over the spend budget — a wall beats a preference', async () => {
    const seen: { toolChoices: unknown[] } = { toolChoices: [] }
    // Both would trip on turn 2. The context guard is checked first, so THAT is
    // what the run is attributed to — the distinction matters because a budget
    // stop is a choice the author made and a context stop is not.
    const result = await run(
      insatiableResearcher(seen),
      MANIFEST(50, 1000, 600),
    )

    expect(result.meta.stoppedOnContextLimit).toBe(true)
    expect(result.meta.stoppedOnTokenBudget).toBeUndefined()
  })
})

// A model whose conversation grows by a fixed amount each turn — the shape the
// guard has to predict. `step` is how much bigger each turn's request is than
// the last, i.e. what one round of tool results adds.
function growingResearcher(
  seen: { toolChoices: unknown[] },
  startAt: number,
  step: number,
) {
  let call = 0
  let input = startAt
  return new MockLanguageModelV3({
    doGenerate: async (opts) => {
      const choice = (opts as { toolChoice?: { type?: string } }).toolChoice
      seen.toolChoices.push(choice)
      const denied = choice?.type === 'none'
      call++
      const thisInput = input
      input += step
      return {
        content: denied
          ? [{ type: 'text' as const, text: 'Here is what I found.' }]
          : [
              {
                type: 'tool-call' as const,
                toolCallId: `c${call}`,
                toolName: 'lookup',
                input: JSON.stringify({ q: 'again' }),
              },
            ],
        finishReason: denied ? mockFinish('stop') : mockFinish('tool-calls'),
        usage: usage(thisInput, 10),
        warnings: [],
      }
    },
  })
}

// The point of measuring growth rather than stopping at a fixed % full: the safe
// stopping point depends on how much this agent's OWN tool results add per turn,
// which no author has measured. Same window, same reserve, two very different
// agents — the guard should let one run far longer than the other.
describe('agent node — the guard adapts to measured growth', () => {
  const WINDOW = 100_000 // reserve defaults to 10% = 10,000

  test('small tool results ride close to the window', async () => {
    const seen: { toolChoices: unknown[] } = { toolChoices: [] }
    // Grows 5K/turn, so turn k sends (k-1)×5K. Denied once the NEXT turn
    // (k×5K) plus the 10K reserve would exceed the window: k×5K > 90K → k = 19.
    // It gets to ~90% of the window because its results are small enough that
    // one more turn genuinely fits.
    await run(growingResearcher(seen, 0, 5_000), MANIFEST(50, null, WINDOW))

    const stoppedAtTurn = seen.toolChoices.findIndex(
      (c) => (c as { type?: string })?.type === 'none',
    )
    expect(stoppedAtTurn).toBe(19)
  })

  test('fat tool results stop far earlier — same window, same reserve', async () => {
    const seen: { toolChoices: unknown[] } = { toolChoices: [] }
    // Grows 40K/turn. Stops once input + 40K + 10K > 100K, i.e. input > 50K —
    // turn 3. A fixed "stop at 90% full" would have allowed another turn here
    // and overflowed on the one that was meant to be the graceful exit.
    await run(growingResearcher(seen, 0, 40_000), MANIFEST(50, null, WINDOW))

    const stoppedAtTurn = seen.toolChoices.findIndex(
      (c) => (c as { type?: string })?.type === 'none',
    )
    expect(stoppedAtTurn).toBe(3)
  })

  test('a bigger answer reserve stops the same agent sooner', async () => {
    const seen: { toolChoices: unknown[] } = { toolChoices: [] }
    const manifest = MANIFEST(50, null, WINDOW)
    // Same 5K/turn agent, 40% reserve: k×5K > 60K → k = 13, six turns of
    // research earlier than the default 10% bought it. This is the knob doing
    // exactly what it says — trading research depth for room to write.
    ;(
      manifest[0] as { config: { answerReservePercent: number } }
    ).config.answerReservePercent = 40
    await run(growingResearcher(seen, 0, 5_000), manifest)

    const stoppedAtTurn = seen.toolChoices.findIndex(
      (c) => (c as { type?: string })?.type === 'none',
    )
    expect(stoppedAtTurn).toBe(13)
  })
})
