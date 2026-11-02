import { beforeEach, describe, expect, test } from 'bun:test'

import type { WfDb } from '../client'
import { freshDb } from '../db-test-helpers'
import {
  wfAgent,
  wfEvalResult,
  wfEvalRun,
  wfFeedback,
  wfRun,
  wfRunLog,
  wfRunStep,
  wfWorkflow,
  wfWorkflowVersion,
} from '../schema'

import { deleteWorkflow } from './authoring-workflows'
import { listWorkflowsWithStats } from './authoring-workflows-stats'
import { getFeedbackForSubjects } from './feedback'
import { listAgentCalls } from './runs-agents'
import { listRuns } from './runs-list'
import { loadRunStats } from './runs-rollup'
import { chunk } from './shared'

// `freshDb()` enforces D1's 100-bound-parameter ceiling (see `D1_LIMITS`), so
// each helper below throws `too many SQL variables` the moment it binds an
// over-budget id list. These tests only have to drive every helper past that
// ceiling and check the rows still come back whole.

/** Insert seed rows a few at a time, so the fixtures stay inside D1's budget. */
async function seed<T>(rows: T[], insert: (rows: T[]) => Promise<unknown>) {
  for (const part of chunk(rows, 5)) await insert(part)
}

function agentMeta(model: string, inputTokens: number, outputTokens: number) {
  return {
    model,
    steps: [{ stepNumber: 1, toolCalls: [] }],
    totalUsage: { inputTokens, outputTokens },
  }
}

// Comfortably past 90 (the chunk size) and past 100 (D1's ceiling), and enough
// to force a third chunk so an off-by-one in the slicing shows up.
const N = 250

describe('D1 parameter budget', () => {
  let db: WfDb

  beforeEach(() => {
    db = freshDb()
  })

  test('getFeedbackForSubjects returns every row for an over-budget id list', async () => {
    const subjectIds = Array.from({ length: N }, (_, i) => `msg-${i}`)
    await seed(subjectIds.map((subjectId) => ({
        subjectId,
        rating: 'up' as const,
      })), (rows) => db.insert(wfFeedback).values(rows))

    const rows = await getFeedbackForSubjects(db, subjectIds)

    expect(rows.length).toBe(N)
    expect(new Set(rows.map((r) => r.subjectId)).size).toBe(N)
  })

  test('loadRunStats aggregates every run across chunks', async () => {
    await db.insert(wfWorkflow).values({ id: 'wf-1', name: 'Intake' })
    await db
      .insert(wfWorkflowVersion)
      .values({ id: 'v-1', workflowId: 'wf-1', versionNumber: 1, graph: {} })
    const runIds = Array.from({ length: N }, (_, i) => `run-${i}`)
    await seed(runIds.map((id) => ({
        id,
        workflowVersionId: 'v-1',
        triggerKind: 'chat',
        status: 'completed' as const,
        isEval: false,
      })), (rows) => db.insert(wfRun).values(rows))
    // Two agent steps per run, so the per-run token sum is only right if the
    // fold sees both — i.e. if chunks are concatenated rather than overwritten.
    await seed(runIds.flatMap((runId, i) => {
        return [1, 2].map((sequence) => ({
          runId,
          nodeId: `node-${sequence}`,
          nodeKind: 'agent',
          sequence,
          status: 'completed' as const,
          meta: agentMeta('m', 10 + i, 5),
        }))
      }), (rows) => db.insert(wfRunStep).values(rows))

    const stats = await loadRunStats(db, runIds)

    expect(stats.size).toBe(N)
    // Every run: two steps of (10 + i) input + 5 output tokens.
    for (const [i, runId] of runIds.entries()) {
      expect(stats.get(runId)?.totalTokens).toBe(2 * (10 + i + 5))
    }
  })

  test('listRuns attaches cost to a full over-budget page', async () => {
    await db.insert(wfWorkflow).values({ id: 'wf-1', name: 'Intake' })
    await db
      .insert(wfWorkflowVersion)
      .values({ id: 'v-1', workflowId: 'wf-1', versionNumber: 1, graph: {} })
    const runIds = Array.from({ length: N }, (_, i) => `run-${i}`)
    await seed(runIds.map((id, i) => ({
        id,
        workflowVersionId: 'v-1',
        triggerKind: 'chat',
        status: 'completed' as const,
        isEval: false,
        createdAt: new Date(1_700_000_000_000 + i * 1000),
      })), (rows) => db.insert(wfRun).values(rows))
    await seed(runIds.map((runId) => ({
        runId,
        nodeId: 'node-1',
        nodeKind: 'agent',
        sequence: 1,
        status: 'completed' as const,
        meta: agentMeta('m', 7, 3),
      })), (rows) => db.insert(wfRunStep).values(rows))

    // 200 is RUN_PAGE_MAX — the largest page a caller can ask for, and twice
    // D1's parameter ceiling.
    const page = await listRuns(db, { limit: 200 })

    expect(page.rows.length).toBe(200)
    expect(page.total).toBe(N)
    for (const row of page.rows) expect(row.totalTokens).toBe(10)
  })

  test('listWorkflowsWithStats rolls up an over-budget workflow set', async () => {
    const workflowIds = Array.from({ length: 150 }, (_, i) => `wf-${i}`)
    await seed(workflowIds.map((id) => ({ id, name: id })), (rows) => db.insert(wfWorkflow).values(rows))
    await seed(workflowIds.map((workflowId) => ({
        id: `v-${workflowId}`,
        workflowId,
        versionNumber: 1,
        graph: { nodes: [], edges: [] },
      })), (rows) => db.insert(wfWorkflowVersion).values(rows))
    // One non-eval run per workflow, so every workflow's `runCount` is 1 —
    // a group lost to chunking would show up as a missing count.
    await seed(workflowIds.map((workflowId) => ({
        id: `run-${workflowId}`,
        workflowVersionId: `v-${workflowId}`,
        triggerKind: 'chat',
        status: 'completed' as const,
        isEval: false,
      })), (rows) => db.insert(wfRun).values(rows))

    const rows = await listWorkflowsWithStats(db)

    expect(rows.length).toBe(150)
    for (const row of rows) {
      expect(row.latestVersionNumber).toBe(1)
      expect(row.runCount).toBe(1)
    }
  })

  test('deleteWorkflow cascades over an over-budget run set', async () => {
    await db.insert(wfWorkflow).values({ id: 'wf-1', name: 'Intake' })
    await db
      .insert(wfWorkflowVersion)
      .values({ id: 'v-1', workflowId: 'wf-1', versionNumber: 1, graph: {} })
    const runIds = Array.from({ length: N }, (_, i) => `run-${i}`)
    await seed(runIds.map((id) => ({
        id,
        workflowVersionId: 'v-1',
        triggerKind: 'chat',
        status: 'completed' as const,
        isEval: false,
      })), (rows) => db.insert(wfRun).values(rows))
    await seed(runIds.map((runId) => ({
        runId,
        nodeId: 'node-1',
        nodeKind: 'agent',
        sequence: 1,
        status: 'completed' as const,
      })), (rows) => db.insert(wfRunStep).values(rows))
    await seed(runIds.map((runId) => ({ runId, level: 'info', message: 'm', ts: 1 })), (rows) => db.insert(wfRunLog).values(rows))
    // One eval run per result, so the eval-run sweep is over budget too.
    await seed(runIds.map((id) => ({ id: `er-${id}` })), (rows) => db.insert(wfEvalRun).values(rows))
    await seed(runIds.map((wfRunId) => ({
        evalRunId: `er-${wfRunId}`,
        rowId: 'row-1',
        wfRunId,
        status: 'pass' as const,
      })), (rows) => db.insert(wfEvalResult).values(rows))

    await deleteWorkflow(db, 'wf-1')

    expect((await db.select().from(wfRun)).length).toBe(0)
    expect((await db.select().from(wfRunStep)).length).toBe(0)
    expect((await db.select().from(wfRunLog)).length).toBe(0)
    expect((await db.select().from(wfEvalResult)).length).toBe(0)
    expect((await db.select().from(wfEvalRun)).length).toBe(0)
    expect((await db.select().from(wfWorkflowVersion)).length).toBe(0)
    expect((await db.select().from(wfWorkflow)).length).toBe(0)
  })

  test('listAgentCalls merges the per-chunk pages into one global top-N', async () => {
    // Every node id is a separate bound parameter in the attribution arm, so
    // 250 agent nodes spread across versions forces three chunked pages — and
    // each page returns its OWN newest `limit` rows, which only add up to the
    // right answer once merged and re-sorted.
    await db.insert(wfAgent).values({ id: 'agent-1', name: 'Drafter' })
    await db.insert(wfWorkflow).values({ id: 'wf-1', name: 'Intake' })
    const nodeIds = Array.from({ length: N }, (_, i) => `node-${i}`)
    await db.insert(wfWorkflowVersion).values({
      id: 'v-1',
      workflowId: 'wf-1',
      versionNumber: 1,
      graph: {
        nodes: nodeIds.map((id) => ({
          id,
          kind: 'agent',
          config: { agentId: 'agent-1' },
        })),
        edges: [],
      },
    })
    // One run per node, newest last. The step carries no `meta.agentId`, so the
    // node-id arm is the ONLY thing attributing it to the agent.
    await seed(nodeIds.map((_, i) => ({
        id: `run-${i}`,
        workflowVersionId: 'v-1',
        triggerKind: 'chat',
        status: 'completed' as const,
        isEval: false,
        createdAt: new Date(1_700_000_000_000 + i * 1000),
      })), (rows) => db.insert(wfRun).values(rows))
    await seed(nodeIds.map((nodeId, i) => ({
        runId: `run-${i}`,
        nodeId,
        nodeKind: 'agent',
        sequence: 1,
        status: 'completed' as const,
        meta: agentMeta('m', 1, 1),
      })), (rows) => db.insert(wfRunStep).values(rows))

    const calls = await listAgentCalls(db, { agentId: 'agent-1', limit: 20 })

    expect(calls.length).toBe(20)
    // The 20 newest runs overall, newest first — NOT whichever rows the last
    // chunk happened to return.
    expect(calls.map((c) => c.runId)).toEqual(
      Array.from({ length: 20 }, (_, i) => `run-${N - 1 - i}`),
    )
  })
})
