import { describe, expect, test } from 'bun:test'

import type { AgentConfig } from '../../engine/graph'
import { createWfDb, type WfDb } from '../../storage/client'
import {
  createAgent,
  createEvalSet,
  getEvalRun,
  listEvalRuns,
  upsertEvalRow,
} from '../../storage/data'
import { freshD1 } from '../../storage/db-test-helpers'
import { createLocalWfDataClient } from '../handlers'

import { testHandlerOptions } from './handler-test-helpers'
import type { CreateWfSdkHandlersOptions } from './shared'

// The launch path the console uses, through the real method table: the run row is
// created with its plan, and its workflow is started.

async function seedGoal(args: { samples: number }) {
  const db = createWfDb(freshD1())
  const { agentId } = await createAgent(db, {
    name: 'Writer',
    config: {
      modelId: 'test-model',
      prompt: 'Write it.',
      userPrompt: 'Write about ${topic}',
      toolIds: [],
      maxTurns: 5,
      inputKind: 'task',
      output: { kind: 'text' },
      subAgents: {
        targets: [],
        maxConcurrent: 4,
        maxSpawns: 10,
        allowStopSignal: true,
      },
    } as unknown as AgentConfig,
  })
  const setId = await createEvalSet(db, {
    name: 'Goal',
    targetKind: 'agent',
    targetId: agentId,
    targetVersion: null,
    triggerKind: 'manual',
  })
  for (let i = 0; i < args.samples; i++) {
    await upsertEvalRow(db, { setId, name: `Sample ${i}` })
  }
  return { db, setId }
}

function clientFor(args: {
  db: WfDb
  startEvalSweep?: CreateWfSdkHandlersOptions<unknown>['startEvalSweep']
  startEvalRun?: CreateWfSdkHandlersOptions<unknown>['startEvalRun']
}) {
  return createLocalWfDataClient(
    testHandlerOptions({
      config: { toolRegistry: new Map() },
      resolveDb: () => args.db,
      startEvalSweep: args.startEvalSweep,
      startEvalRun: args.startEvalRun,
    }),
    { ctx: { userId: 'user-1' }, req: new Request('https://test.internal') },
  )
}

describe('launchEvalSweep', () => {
  test('creates the run with its plan, and starts its workflow', async () => {
    const { db, setId } = await seedGoal({ samples: 3 })
    const started: string[] = []
    const client = clientFor({
      db,
      startEvalSweep: async ({ evalRunId }) => {
        started.push(evalRunId)
        return { started: true }
      },
    })

    const { evalRunId } = await client.launchEvalSweep({ setIds: [setId] })

    expect(started).toEqual([evalRunId])
    const found = await getEvalRun(db, evalRunId)
    expect(found?.run.status).toBe('queued')
    expect(found?.run.total).toBe(3)
    expect(found?.run.createdBy).toBe('user-1')
    const drive = await client.getEvalRunDrive(evalRunId)
    expect(drive?.plan?.cells).toHaveLength(3)
  })

  test('cancels the run when its workflow cannot start', async () => {
    const { db, setId } = await seedGoal({ samples: 1 })
    const client = clientFor({
      db,
      startEvalSweep: async () => {
        throw new Error('Workflows is unavailable')
      },
    })
    await expect(client.launchEvalSweep({ setIds: [setId] })).rejects.toThrow(
      'Workflows is unavailable',
    )
    const runs = await listEvalRuns(db, {})
    expect(runs.map((r) => r.status)).toEqual(['cancelled'])
  })

  test('refuses a judged sweep with no judge before creating a run', async () => {
    const { db, setId } = await seedGoal({ samples: 0 })
    await upsertEvalRow(db, {
      setId,
      name: 'Judged',
      checks: {
        op: 'and',
        checks: [{ type: 'decision_judge', rubric: 'Is it right?' }],
      },
    })
    const client = clientFor({ db })
    await expect(client.launchEvalSweep({ setIds: [setId] })).rejects.toThrow(
      /pick the decision judge/,
    )
    expect(await listEvalRuns(db, {})).toEqual([])
  })

  test('a host with no sweep hook is told so', async () => {
    const { db, setId } = await seedGoal({ samples: 1 })
    const client = clientFor({ db })
    await expect(client.launchEvalSweep({ setIds: [setId] })).rejects.toThrow(
      /not configured/,
    )
  })
})

describe('startEvalRun', () => {
  test('tells the host who launched the sweep, and where to report', async () => {
    const { db, setId } = await seedGoal({ samples: 1 })
    const seen: unknown[] = []
    const client = clientFor({
      db,
      startEvalSweep: async () => ({ started: true }),
      startEvalRun: async ({ launchedBy, sweepNotice }) => {
        seen.push({ launchedBy, sweepNotice })
        return { wfRunId: 'run_1' }
      },
    })
    const { evalRunId } = await client.launchEvalSweep({ setIds: [setId] })
    const drive = await client.getEvalRunDrive(evalRunId)
    await client.startEvalRun({
      evalRunId,
      rowId: drive!.plan!.cells[0].rowId,
      sweepEvent: 'cell-1',
    })
    expect(seen).toEqual([
      {
        launchedBy: 'user-1',
        sweepNotice: { instanceId: evalRunId, eventType: 'cell-1' },
      },
    ])
  })
})
