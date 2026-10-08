import { beforeEach, describe, expect, test } from 'bun:test'

import type { Decider } from '../../engine/decision'
import {
  starterDecisionAgentConfig,
  type DecisionAgentConfig,
} from '../../engine/decision-agent-schema'
import type { CheckTree, EvalSampleInput } from '../../engine/eval-schema'
import { agentCallTotals } from '../../eval/report'
import { createWfDb, type WfDb } from '../../storage/client'
import {
  createAgent,
  createEvalRun,
  createEvalSet,
  getEvalRun,
  invalidateModelPriceMap,
  upsertEvalRow,
  upsertModels,
} from '../../storage/data'
import { freshD1, freshDb } from '../../storage/db-test-helpers'

import { buildEvalHandlers } from './evals'
import { testHandlerCtx, testHandlerOptions } from './handler-test-helpers'

// `runDecisionEvalCell` — one cell of a decision sweep, start to finish in one
// call. There is no `wf_run` behind it: a decision agent has no graph, so
// there is nothing to start, poll or record steps against, and this is the
// handler that has to make that true without breaking the invariant every
// other eval path rests on — that a settled cell wrote a row.

function agentConfig(): DecisionAgentConfig {
  const starter = starterDecisionAgentConfig('venice:jev-latest')
  return {
    ...starter,
    questions: starter.questions.map((q) => ({
      ...q,
      prompt: 'Does this need a person to look at it before we act?',
    })),
  }
}

/** Answers `needs_review` with `probability`, echoing a pinned model id. */
function decider(probability: number): Decider {
  return async () => ({
    modelId: 'venice:jev-2026-01',
    answers: [{ id: 'needs_review', type: 'boolean', probability }],
    usage: { inputTokens: 40, outputTokens: 5 },
  })
}

function checks (verdict: string): CheckTree {
  return ({
    op: 'and',
    checks: [{ type: 'decision_answers', verdict, expect: [] }],
  })
}

describe('runDecisionEvalCell', () => {
  let db: WfDb
  let agentId: string
  let rowId: string
  let evalRunId: string

  async function seed(input: EvalSampleInput, tree: CheckTree) {
    db = freshDb()
    const created = await createAgent(db, {
      name: 'Triage',
      kind: 'decision',
      config: agentConfig(),
    })
    agentId = created.agentId
    const setId = await createEvalSet(db, {
      name: 'Triage goal',
      targetKind: 'agent',
      targetId: agentId,
      targetVersion: null,
      triggerKind: 'manual',
    })
    rowId = await upsertEvalRow(db, {
      setId,
      name: 'Angry client',
      input,
      tools: { fallback: 'mocked', byTool: {} },
      checks: tree,
    })
    evalRunId = await createEvalRun(db, { setIds: [setId], total: 1 })
  }

  const handlers = (probability = 0.91) => {
    return buildEvalHandlers(
      testHandlerOptions({
        config: { getDecider: () => decider(probability) },
      }),
    )
  }

  beforeEach(async () => {
    await seed(
      { kind: 'decision', state: 'Customer is furious about a duplicate charge.', variables: {} },
      checks('review'),
    )
  })

  test('judges the state, grades it and persists the result with NO wf_run', async () => {
    const result = await handlers().runDecisionEvalCell(
      testHandlerCtx(db, { evalRunId, rowId }),
    )
    expect(result.status).toBe('pass')
    expect(result.wfRunId).toBeNull()
    // The echoed id, not the one the cell asked with — `jev-latest` floats,
    // and this is the only record of that third drift axis.
    expect(result.answeredModelId).toBe('venice:jev-2026-01')

    // Persisted, not just returned: `finalizeEvalRun` rolls up the rows that
    // exist, so a cell that writes nothing shrinks the report's totals.
    const stored = await getEvalRun(db, evalRunId)
    expect(stored?.results).toHaveLength(1)
    expect(stored?.results[0]?.status).toBe('pass')
    // And it freezes the Sample it graded, so editing the sample later doesn't
    // rewrite how this run reads.
    expect(stored?.results[0]?.snapshot).toBeTruthy()
  })

  test('flips the umbrella run out of `queued` on its first cell', async () => {
    // The run path does this in `startEvalRun`, which a decision cell never
    // reaches — without it a finished sweep would read as never started.
    expect((await getEvalRun(db, evalRunId))?.run.status).toBe('queued')
    await handlers().runDecisionEvalCell(testHandlerCtx(db, { evalRunId, rowId }))
    expect((await getEvalRun(db, evalRunId))?.run.status).toBe('running')
  })

  test('a wrong verdict fails the cell and says which verdict it got', async () => {
    await seed(
      { kind: 'decision', state: 'Routine thank-you note.', variables: {} },
      checks('review'),
    )
    const result = await handlers(0.05).runDecisionEvalCell(
      testHandlerCtx(db, { evalRunId, rowId }),
    )
    expect(result.status).toBe('fail')
    expect(result.checkResults[0]?.reason).toContain('proceed')
  })

  test('the matrix model column overrides the agent’s own decider', async () => {
    let asked: string | undefined
    const h = buildEvalHandlers(
      testHandlerOptions({
        config: {
          getDecider: (modelId: string) => {
            asked = modelId
            return decider(0.91)
          },
        },
      }),
    )
    await h.runDecisionEvalCell(
      testHandlerCtx(db, { evalRunId, rowId, modelId: 'venice:other' }),
    )
    expect(asked).toBe('venice:other')
  })

  test('a draft override is graded instead of the published version', async () => {
    const draft: DecisionAgentConfig = {
      ...agentConfig(),
      verdicts: ['always'],
      rules: [{ id: 'r1', verdict: 'always', conditions: [] }],
    }
    const result = await handlers().runDecisionEvalCell(
      testHandlerCtx(db, { evalRunId, rowId, config: draft }),
    )
    // The published config would have said `review`; the draft's single
    // fallback rule says `always`, and the check expected `review`.
    expect(result.status).toBe('fail')
  })

  test('a generation-agent goal is refused rather than judged as a decision', async () => {
    db = freshDb()
    const created = await createAgent(db, {
      name: 'Greeter',
      config: {
        modelId: 'm',
        prompt: 'Hi.',
        userPrompt: 'Say hi to ${name}',
        toolIds: [],
        maxTurns: 1,
        toolTokenBudget: null,
        answerReservePercent: 10,
        requireToolFirstTurn: false,
        reasoning: false,
        webSearch: 'off',
        webCitations: false,
        referenceKinds: [],
        inputKind: 'task',
        output: { kind: 'text' },
        subAgents: {
          targets: [],
          maxConcurrent: 4,
          maxSpawns: 10,
          allowStopSignal: true,
        },
      },
    })
    const setId = await createEvalSet(db, {
      name: 'Greeter goal',
      targetKind: 'agent',
      targetId: created.agentId,
      targetVersion: null,
      triggerKind: 'manual',
    })
    const row = await upsertEvalRow(db, {
      setId,
      name: 'Sample',
      input: { kind: 'task', variables: {} },
      tools: { fallback: 'mocked', byTool: {} },
      checks: { op: 'and', checks: [] },
    })
    const runId = await createEvalRun(db, { setIds: [setId], total: 1 })
    await expect(
      handlers().runDecisionEvalCell(
        testHandlerCtx(db, { evalRunId: runId, rowId: row }),
      ),
    ).rejects.toThrow(/startEvalRun/)
  })

  test('a host with no decision provider refuses before anything is written', async () => {
    const h = buildEvalHandlers(testHandlerOptions())
    await expect(
      h.runDecisionEvalCell(testHandlerCtx(db, { evalRunId, rowId })),
    ).rejects.toThrow(/no decision provider/i)
    expect((await getEvalRun(db, evalRunId))?.results).toHaveLength(0)
  })
})

// ── Cost ─────────────────────────────────────────────────────────────────────
//
// A decision cell has no `wf_run`, so the usual cost derivation (fold the run's
// agent steps) has nothing to read and a decision sweep reported `measuredCells:
// 0` while the provider returned usage on every call. The usage is recorded on
// the result row and assembled back into the same `runStats` shape, so every
// surface that already renders cost renders this one too.

describe('runDecisionEvalCell — what the cell cost', () => {
  let db: WfDb
  let rowId: string
  let evalRunId: string

  /** The decision model, catalogued and priced as a refresh would leave it. */
  async function catalogueJev(
    price: { prompt: number; completion: number } = {
      prompt: 0.042,
      completion: 0,
    },
  ) {
    await upsertModels(db, 'venice', [
      {
        // The id the decider ECHOES, which is what a run-less cell prices
        // against — see `runlessCellStats`.
        id: 'venice:jev-2026-01',
        modelId: 'jev-2026-01',
        label: 'Jev (System One)',
        providerId: 'venice',
        kind: 'decision',
        promptPricePerMTok: price.prompt,
        completionPricePerMTok: price.completion,
      },
    ])
  }

  const handlers = () => {
    return buildEvalHandlers(
      testHandlerOptions({ config: { getDecider: () => decider(0.91) } }),
    )
  }

  beforeEach(async () => {
    // `createWfDb` over a D1 facade: `upsertModels` batches.
    db = createWfDb(freshD1())
    const created = await createAgent(db, {
      name: 'Triage',
      kind: 'decision',
      config: agentConfig(),
    })
    const setId = await createEvalSet(db, {
      name: 'Triage goal',
      targetKind: 'agent',
      targetId: created.agentId,
      targetVersion: null,
      triggerKind: 'manual',
    })
    rowId = await upsertEvalRow(db, {
      setId,
      name: 'Angry client',
      input: {
        kind: 'decision',
        state: 'Customer is furious about a duplicate charge.',
        variables: {},
      },
      tools: { fallback: 'mocked', byTool: {} },
      checks: checks('review'),
    })
    evalRunId = await createEvalRun(db, { setIds: [setId], total: 1 })
  })

  test('the provider’s usage reaches the result row', async () => {
    await handlers().runDecisionEvalCell(testHandlerCtx(db, { evalRunId, rowId }))
    const stored = await getEvalRun(db, evalRunId)
    expect(stored?.results[0]?.inputTokens).toBe(40)
    expect(stored?.results[0]?.outputTokens).toBe(5)
  })

  test('the cell reports tokens and dollars as runStats, like any other cell', async () => {
    await catalogueJev()
    const result = await handlers().runDecisionEvalCell(
      testHandlerCtx(db, { evalRunId, rowId }),
    )
    expect(result.runStats?.totalTokens).toBe(45)
    // 40 in × $0.042/1M + 5 out × $0/1M.
    expect(result.runStats?.costUsd).toBeCloseTo((40 * 0.042) / 1_000_000, 12)
    // No run to time, and nothing invented to fill the gap.
    expect(result.runStats?.durationMs).toBeNull()
  })

  test('the report derives the same figures when it re-reads the run', async () => {
    await catalogueJev()
    await handlers().runDecisionEvalCell(testHandlerCtx(db, { evalRunId, rowId }))
    const detail = await handlers().getEvalRun(
      testHandlerCtx(db, { evalRunId }),
    )
    expect(detail?.results[0]?.runStats?.totalTokens).toBe(45)
    expect(detail?.results[0]?.runStats?.costUsd).toBeCloseTo(
      (40 * 0.042) / 1_000_000,
      12,
    )
  })

  test('a re-priced catalog re-prices history — the dollars are derived, not stored', async () => {
    await catalogueJev()
    await handlers().runDecisionEvalCell(testHandlerCtx(db, { evalRunId, rowId }))
    const before = (
      await handlers().getEvalRun(testHandlerCtx(db, { evalRunId }))
    )?.results[0]?.runStats?.costUsd
    // Ten times the price, same recorded tokens.
    await catalogueJev({ prompt: 0.42, completion: 0 })
    invalidateModelPriceMap(db)
    const after = (
      await handlers().getEvalRun(testHandlerCtx(db, { evalRunId }))
    )?.results[0]?.runStats?.costUsd
    expect(before).toBeGreaterThan(0)
    expect(after).toBeCloseTo((before ?? 0) * 10, 12)
  })

  test('an uncatalogued decider reports tokens but no dollars, never a wrong zero', async () => {
    const result = await handlers().runDecisionEvalCell(
      testHandlerCtx(db, { evalRunId, rowId }),
    )
    expect(result.runStats?.totalTokens).toBe(45)
    expect(result.runStats?.costUsd).toBeNull()
  })

  test('the sweep rollup counts the cell as measured', async () => {
    await catalogueJev()
    await handlers().runDecisionEvalCell(testHandlerCtx(db, { evalRunId, rowId }))
    const detail = await handlers().getEvalRun(
      testHandlerCtx(db, { evalRunId }),
    )
    const totals = agentCallTotals(detail?.results ?? [])
    // The regression this closes: `measuredCells: 0` on a sweep that spent money.
    expect(totals.count).toBe(1)
    expect(totals.totalTokens).toBe(45)
    expect(totals.totalCostUsd).toBeCloseTo((40 * 0.042) / 1_000_000, 12)
  })
})
