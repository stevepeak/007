import { describe, expect, test } from 'bun:test'

import type { CheckTree, WfDataClient } from '../server/protocol'

import type { EvalPlan } from './plan'
import { createEvalSweep } from './run-eval'

// One judge per run: a launch must name the decision judge when its Samples
// carry a judge check, and freezes it only then.

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

const judged: CheckTree = {
  op: 'and',
  checks: [{ type: 'decision_judge', rubric: 'b' }],
}

describe('createEvalSweep — the run picks the judge', () => {
  test('refuses a judged sweep with no decision judge', async () => {
    const { client } = sweepClient(judged)
    await expect(
      createEvalSweep(client, { setIds: ['set_1'] }),
    ).rejects.toThrow('pick the decision judge')
  })

  test('a legacy llm_judge still needs the decision judge', async () => {
    const { client } = sweepClient({
      op: 'and',
      checks: [{ type: 'llm_judge', rubric: 'a' } as never],
    })
    await expect(
      createEvalSweep(client, { setIds: ['set_1'] }),
    ).rejects.toThrow('pick the decision judge')
  })

  test('freezes the judge when the Samples carry judge checks', async () => {
    const { client, planOf } = sweepClient(judged)
    await createEvalSweep(client, {
      setIds: ['set_1'],
      decisionJudgeModelId: 'd',
    })
    expect(planOf()?.decisionJudgeModelId).toBe('d')
  })

  test('a sweep with no judge checks needs, and freezes, no judge', async () => {
    const { client, planOf } = sweepClient({
      op: 'and',
      checks: [{ type: 'tool_called', toolId: 't', called: true }],
    })
    await createEvalSweep(client, {
      setIds: ['set_1'],
      decisionJudgeModelId: 'd',
    })
    expect(planOf()?.decisionJudgeModelId).toBeUndefined()
  })
})
