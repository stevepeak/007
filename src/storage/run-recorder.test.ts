import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import type { ModelPriceMap } from '../engine/cost'

import type { WfDb } from './client'
import { loadDashboard } from './data/dashboard'
import { listAgentCalls } from './data/runs-agents'
import { aggregateRunCost, invalidateModelPriceMap, loadModelPriceMap } from './data/runs-cost'
import { getRun } from './data/runs-inspector'
import { rollUpRunCost } from './data/runs-rollup'
import { freshDb } from './db-test-helpers'
import { createDurableRunRecorder } from './run-recorder'
import { wfModel, wfRun, wfRunStep, wfWorkflow, wfWorkflowVersion } from './schema'

// A step's dollars are fixed by the prices its run froze: every D1 read reports
// the same figure, and a later catalog edit moves none of them. Agreement with
// the Analytics Engine point is pinned in `graph-workflow-telemetry.test.ts`.

const RUN_ID = 'run-1'
const AGENT_ID = 'agent-1'
const MODEL = 'model-a'
/** 1M tokens each way at the prices below: $1 + $2. */
const FROZEN_COST = 3
const FROZEN: ModelPriceMap = new Map([
  [MODEL, { promptPerMTok: 1, completionPerMTok: 2 }],
])
const META = {
  model: MODEL,
  agentId: AGENT_ID,
  steps: [{ stepNumber: 1, toolCalls: [] }],
  totalUsage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
}
const AGENT_STEP = {
  nodeId: 'node-1',
  nodeKind: 'agent',
  sequence: 1,
  input: {},
  status: 'completed',
  meta: META,
} as const

let db: WfDb

beforeEach(async () => {
  db = freshDb()
  await db.insert(wfWorkflow).values({ id: 'wf-1', name: 'Flow' })
  await db
    .insert(wfWorkflowVersion)
    .values({ id: 'ver-1', workflowId: 'wf-1', versionNumber: 1, graph: {} })
  await db.insert(wfRun).values({
    id: RUN_ID,
    workflowVersionId: 'ver-1',
    triggerKind: 'chat',
    status: 'completed',
    createdAt: new Date(),
  })
  await db.insert(wfModel).values({
    id: `test:${MODEL}`,
    providerId: 'test',
    modelId: MODEL,
    label: 'Model A',
    promptPricePerMTok: 1,
    completionPricePerMTok: 2,
  })
})

async function storedCost(): Promise<number | null | undefined> {
  const rows = await db
    .select({ cost: wfRunStep.costUsdAtRun })
    .from(wfRunStep)
    .where(eq(wfRunStep.runId, RUN_ID))
  return rows[0]?.cost
}

/** A provider repricing the model a hundredfold, after the run finished. */
async function repriceCatalog() {
  await db
    .update(wfModel)
    .set({ promptPricePerMTok: 100, completionPricePerMTok: 200 })
    .where(eq(wfModel.modelId, MODEL))
  invalidateModelPriceMap(db)
}

/** Every D1 read that reports this run's cost. */
async function everyReadOfCost(): Promise<Record<string, unknown>> {
  const [own, tree, run, calls, dashboard] = await Promise.all([
    aggregateRunCost(db, [RUN_ID]),
    rollUpRunCost(db, [RUN_ID]),
    // Cost doesn't need the graph, and this version's isn't a parseable one.
    getRun(db, RUN_ID, { knownVersionId: 'ver-1' }),
    listAgentCalls(db, { agentId: AGENT_ID }),
    loadDashboard(db, { since: Date.now() - 86_400_000 }),
  ])
  return {
    aggregate: own.get(RUN_ID)?.costUsd,
    rollUp: tree.get(RUN_ID)?.costUsd,
    inspectorRun: run?.costUsd,
    inspectorStep: run?.steps[0]?.costUsd,
    agentCall: calls[0]?.costUsd,
    dashboard: dashboard.cost.totalUsd,
  }
}

describe('createDurableRunRecorder pricing', () => {
  test('stamps the dollars from the prices it was given', async () => {
    const recorder = createDurableRunRecorder({ db, runId: RUN_ID, prices: FROZEN })
    await recorder.record(AGENT_STEP)
    expect(await storedCost()).toBe(FROZEN_COST)
  })

  test('the opening record has no usage; the terminal record stamps over it', async () => {
    const recorder = createDurableRunRecorder({ db, runId: RUN_ID, prices: FROZEN })
    await recorder.record({ ...AGENT_STEP, status: 'running', meta: undefined })
    expect(await storedCost()).toBeNull()
    await recorder.record(AGENT_STEP)
    expect(await storedCost()).toBe(FROZEN_COST)
  })

  test('a model missing from the frozen table stays null, not $0', async () => {
    const recorder = createDurableRunRecorder({ db, runId: RUN_ID, prices: new Map() })
    await recorder.record(AGENT_STEP)
    expect(await storedCost()).toBeNull()
  })

  test('a free model stamps a real zero', async () => {
    const recorder = createDurableRunRecorder({
      db,
      runId: RUN_ID,
      prices: new Map([[MODEL, { promptPerMTok: 0, completionPerMTok: 0 }]]),
    })
    await recorder.record(AGENT_STEP)
    expect(await storedCost()).toBe(0)
  })
})

describe('run-time cost is the one figure', () => {
  test('a catalog edit moves no read of a stamped step', async () => {
    const recorder = createDurableRunRecorder({
      db,
      runId: RUN_ID,
      prices: await loadModelPriceMap(db),
    })
    await recorder.record(AGENT_STEP)
    await repriceCatalog()

    expect(await everyReadOfCost()).toEqual({
      aggregate: FROZEN_COST,
      rollUp: FROZEN_COST,
      inspectorRun: FROZEN_COST,
      inspectorStep: FROZEN_COST,
      agentCall: FROZEN_COST,
      dashboard: FROZEN_COST,
    })
  })

  test('a row from before the column still prices at the current catalog', async () => {
    await db.insert(wfRunStep).values({
      runId: RUN_ID,
      nodeId: 'node-1',
      nodeKind: 'agent',
      sequence: 1,
      status: 'completed',
      meta: META,
    })
    await repriceCatalog()

    const repriced = 300
    expect(await everyReadOfCost()).toEqual({
      aggregate: repriced,
      rollUp: repriced,
      inspectorRun: repriced,
      inspectorStep: repriced,
      agentCall: repriced,
      dashboard: repriced,
    })
  })
})
