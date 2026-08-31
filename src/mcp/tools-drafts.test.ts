import { describe, expect, test } from 'bun:test'

import type { AgentNodeMeta } from '../engine/nodes/agent'
import type { WfDataClient } from '../server/protocol'

import { draftTools } from './tools-drafts'

/**
 * The tool around the conversion (`eval/from-run` covers the conversion itself).
 * What is worth pinning here is the choosing: which agent step, which agent, and
 * what happens when the run doesn't answer those questions on its own.
 */

const tool = draftTools()[0]

function stubClient(partial: Partial<WfDataClient>): WfDataClient {
  return partial as WfDataClient
}

function agentStep(cursor: number, over: Partial<AgentNodeMeta> = {}) {
  return {
    cursor,
    nodeId: `n${cursor}`,
    nodeKind: 'agent',
    parentNodeId: null,
    itemIndex: null,
    input: {},
    output: { text: 'the answer' },
    meta: {
      model: 'venice/x',
      systemPrompt: '',
      totalUsage: { inputTokens: 0, outputTokens: 0 },
      agentId: 'ag_1',
      agentVersion: 2,
      messages: [{ role: 'user', text: 'hello' }],
      steps: [],
      ...over,
    },
  }
}

function runDetail(steps: unknown[]) {
  return { run: { id: 'run_1' }, steps, logs: [], graph: null } as never
}

const agent = {
  agent: {
    id: 'ag_1',
    name: 'Conflict check',
    inputKind: 'conversation',
    inputVariables: [],
    latestVersionNumber: 3,
  },
} as never

function client(over: Partial<WfDataClient> = {}): WfDataClient {
  return stubClient({
    getRun: async () => runDetail([agentStep(5)]),
    getAgent: async () => agent,
    listFeedback: async () => ({ rows: [], correlations: [], raters: [] }),
    listEvalSets: async () => [],
    ...over,
  })
}

describe('choosing the step', () => {
  test('drafts without a cursor when the run has one agent step', async () => {
    const result = (await tool.run(client(), { runId: 'run_1' })) as {
      cursor: number
      draft: { input: unknown }
    }
    expect(result.cursor).toBe(5)
    expect(result.draft.input).toEqual({
      kind: 'conversation',
      turns: [{ role: 'user', text: 'hello' }],
      variables: {},
    })
  })

  // Each step is a different agent with a different contract, so a sample built
  // from the wrong one grades the wrong thing.
  test('refuses to pick between several, and lists them', async () => {
    const many = client({
      getRun: async () =>
        runDetail([agentStep(2), agentStep(7, { agentId: 'ag_2' })]),
    })
    const result = (await tool.run(many, { runId: 'run_1' })) as {
      error: string
      candidates: { cursor: number; agentId: string }[]
    }
    expect(result.error).toContain('2 agent steps')
    expect(result.candidates.map((c) => c.cursor)).toEqual([2, 7])
  })

  test('names the cursors it has when given a wrong one', async () => {
    const result = (await tool.run(client(), {
      runId: 'run_1',
      cursor: 99,
    })) as { error: string; candidates: unknown[] }
    expect(result.error).toContain('no agent step with cursor 99')
    expect(result.candidates).toHaveLength(1)
  })

  test('says so when the run has no agent step at all', async () => {
    const noAgents = client({
      getRun: async () =>
        runDetail([{ ...agentStep(1), nodeKind: 'tool', meta: {} }]),
    })
    expect(
      ((await tool.run(noAgents, { runId: 'run_1' })) as { error: string })
        .error,
    ).toContain('no agent steps')
  })
})

describe('resolving the target', () => {
  test('reads the agent contract rather than assuming one', async () => {
    const taskAgent = client({
      getAgent: async () =>
        ({
          agent: {
            id: 'ag_1',
            name: 'Extractor',
            inputKind: 'task',
            inputVariables: ['doc'],
            latestVersionNumber: 1,
          },
        }) as never,
      getRun: async () =>
        runDetail([{ ...agentStep(5), input: { doc: 'a lease' } }]),
    })
    const result = (await tool.run(taskAgent, { runId: 'run_1' })) as {
      draft: { input: { kind: string; variables: Record<string, string> } }
    }
    expect(result.draft.input.kind).toBe('task')
    expect(result.draft.input.variables).toEqual({ doc: 'a lease' })
  })

  test('reports the version drift the sample will be graded against', async () => {
    const result = (await tool.run(client(), { runId: 'run_1' })) as {
      target: { ranVersion: number; latestVersion: number }
    }
    // The run ranged v2; a floating goal grades v3. Silently drafting against a
    // different version than the failure happened on is the classic eval lie.
    expect(result.target.ranVersion).toBe(2)
    expect(result.target.latestVersion).toBe(3)
  })

  test('refuses when the step names no agent and the graph is gone', async () => {
    const orphan = client({
      getRun: async () => runDetail([agentStep(5, { agentId: undefined })]),
    })
    expect(
      ((await tool.run(orphan, { runId: 'run_1' })) as { error: string }).error,
    ).toContain('no target')
  })
})

describe('the surrounding signal', () => {
  test('finds the thumbs-down that makes this run worth a sample', async () => {
    const rated = client({
      listFeedback: async () =>
        ({
          rows: [
            { runId: 'other', rating: 'up', note: null },
            { runId: 'run_1', rating: 'down', note: 'Missed the Bex matter.' },
          ],
          correlations: [],
          raters: [],
        }) as never,
    })
    const result = (await tool.run(rated, { runId: 'run_1' })) as {
      feedback: { rating: string; note: string }
      draft: { checks: { checks: { type: string; rubric?: string }[] } }
    }
    expect(result.feedback).toEqual({
      rating: 'down',
      note: 'Missed the Bex matter.',
    })
    const judge = result.draft.checks.checks.find((c) => c.type === 'llm_judge')
    expect(judge?.rubric).toContain('Missed the Bex matter.')
  })

  // A host with no feedback wiring must still be able to draft from a run.
  test('drafts anyway when feedback is unavailable', async () => {
    const broken = client({
      listFeedback: async () => {
        throw new Error('not wired')
      },
    })
    const result = (await tool.run(broken, { runId: 'run_1' })) as {
      feedback: null
      draft: unknown
    }
    expect(result.feedback).toBeNull()
    expect(result.draft).toBeDefined()
  })

  test('points at a goal that already targets this agent', async () => {
    const withGoal = client({
      listEvalSets: async () =>
        [
          {
            id: 'set_1',
            name: 'Conflicts',
            targetKind: 'agent',
            targetId: 'ag_1',
          },
          { id: 'set_2', name: 'Other', targetKind: 'agent', targetId: 'ag_9' },
        ] as never,
    })
    const result = (await tool.run(withGoal, { runId: 'run_1' })) as {
      goals: { setId: string; name: string }[]
      next: string
    }
    expect(result.goals).toEqual([{ setId: 'set_1', name: 'Conflicts' }])
    expect(result.next).toContain('set_1')
  })
})

describe('the layer argument', () => {
  test('rejects a layer it does not have', async () => {
    const result = (await tool.run(client(), {
      runId: 'run_1',
      layer: 'vibes',
    })) as { error: string }
    expect(result.error).toContain('trajectory')
  })

  test('is read-only — drafting writes nothing', () => {
    expect(tool.readOnly).toBe(true)
  })
})
