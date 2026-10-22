import { describe, expect, test } from 'bun:test'

import type { CheckTree, WfDataClient } from '../server/protocol'

import type { EvalPlan } from './plan'
import { createEvalSweep } from './run-eval'

// One judge per run: a launch must name a judge for every judge kind its
// Samples carry, and freezes only those onto the plan.

function sweepClient(checks: CheckTree) {
  let plan: EvalPlan | null = null
  const client = {
    getEvalSet: async () => {
      return { set: { id: 'set_1' }, rows: [{ id: 'row_1', checks }] }
    },
    createEvalRun: async (input: { plan: EvalPlan }) => {
      plan = input.plan
      return { evalRunId: 'er_1' }
    },
  } as unknown as WfDataClient
  return { client, planOf: () => plan }
}

const both: CheckTree = {
  op: 'and',
  checks: [
    { type: 'llm_judge', rubric: 'a' },
    { type: 'decision_judge', rubric: 'b' },
  ],
}

describe('createEvalSweep — the run picks the judges', () => {
  test('refuses an llm_judge sweep with no judge model', async () => {
    const { client } = sweepClient(both)
    await expect(
      createEvalSweep(client, {
        setIds: ['set_1'],
        decisionJudgeModelId: 'd',
      }),
    ).rejects.toThrow('pick the judge model')
  })

  test('refuses a decision_judge sweep with no decision judge', async () => {
    const { client } = sweepClient(both)
    await expect(
      createEvalSweep(client, { setIds: ['set_1'], judgeModelId: 'j' }),
    ).rejects.toThrow('pick the decision judge')
  })

  test('freezes both judges when both kinds are present', async () => {
    const { client, planOf } = sweepClient(both)
    await createEvalSweep(client, {
      setIds: ['set_1'],
      judgeModelId: 'j',
      decisionJudgeModelId: 'd',
    })
    expect(planOf()?.judgeModelId).toBe('j')
    expect(planOf()?.decisionJudgeModelId).toBe('d')
  })

  test('a sweep with no judge checks needs, and freezes, no judge', async () => {
    const { client, planOf } = sweepClient({
      op: 'and',
      checks: [{ type: 'tool_called', toolId: 't', called: true }],
    })
    await createEvalSweep(client, { setIds: ['set_1'], judgeModelId: 'j' })
    expect(planOf()?.judgeModelId).toBeUndefined()
    expect(planOf()?.decisionJudgeModelId).toBeUndefined()
  })
})
