import { beforeEach, describe, expect, test } from 'bun:test'

import type { WfDb } from '../client'
import { freshDb } from '../db-test-helpers'
import {
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
import { previewRunPrune, pruneRuns } from './runs-purge'

async function seedRun(db: WfDb, args: { id: string; versionId: string }) {
  await db.insert(wfRun).values({
    id: args.id,
    workflowVersionId: args.versionId,
    triggerKind: 'eval',
    status: 'completed',
    isEval: true,
  })
  await db.insert(wfRunStep).values({
    runId: args.id,
    nodeId: 'node-1',
    nodeKind: 'agent',
    sequence: 1,
    status: 'completed',
  })
  await db
    .insert(wfRunLog)
    .values({ runId: args.id, level: 'info', message: 'hi', ts: 1 })
}

describe('deleteWorkflow cascade', () => {
  let db: WfDb

  beforeEach(async () => {
    db = freshDb()
    await db.insert(wfWorkflow).values([
      { id: 'wf-gone', name: 'Gone' },
      { id: 'wf-kept', name: 'Kept' },
    ])
    await db.insert(wfWorkflowVersion).values([
      { id: 'v-gone', workflowId: 'wf-gone', versionNumber: 1, graph: {} },
      { id: 'v-kept', workflowId: 'wf-kept', versionNumber: 1, graph: {} },
    ])
    await seedRun(db, { id: 'run-gone', versionId: 'v-gone' })
    await seedRun(db, { id: 'run-kept', versionId: 'v-kept' })
    // `er-only` graded just the deleted workflow; `er-shared` graded both.
    await db.insert(wfEvalRun).values([{ id: 'er-only' }, { id: 'er-shared' }])
    await db.insert(wfEvalResult).values([
      { evalRunId: 'er-only', rowId: 'r', wfRunId: 'run-gone', status: 'pass' },
      {
        evalRunId: 'er-shared',
        rowId: 'r',
        wfRunId: 'run-gone',
        status: 'pass',
      },
      {
        evalRunId: 'er-shared',
        rowId: 'r',
        wfRunId: 'run-kept',
        status: 'pass',
      },
    ])
    await db.insert(wfFeedback).values([
      { subjectId: 's-gone', runId: 'run-gone', rating: 'up' },
      { subjectId: 's-kept', runId: 'run-kept', rating: 'down' },
    ])
  })

  test('removes the runs and everything derived from them', async () => {
    await deleteWorkflow(db, 'wf-gone')

    const runIds = (rows: { runId: string }[]) => rows.map((r) => r.runId)
    expect((await db.select().from(wfRun)).map((r) => r.id)).toEqual([
      'run-kept',
    ])
    expect(runIds(await db.select().from(wfRunStep))).toEqual(['run-kept'])
    expect(runIds(await db.select().from(wfRunLog))).toEqual(['run-kept'])
    expect(
      (await db.select().from(wfEvalResult)).map((r) => r.wfRunId),
    ).toEqual(['run-kept'])
  })

  test('drops an eval run only once none of its results remain', async () => {
    await deleteWorkflow(db, 'wf-gone')

    expect((await db.select().from(wfEvalRun)).map((r) => r.id)).toEqual([
      'er-shared',
    ])
  })

  test('keeps feedback but unlinks it from the deleted run', async () => {
    await deleteWorkflow(db, 'wf-gone')

    const feedback = await db
      .select({ subjectId: wfFeedback.subjectId, runId: wfFeedback.runId })
      .from(wfFeedback)
      .orderBy(wfFeedback.subjectId)
    expect(feedback).toEqual([
      { subjectId: 's-gone', runId: null },
      { subjectId: 's-kept', runId: 'run-kept' },
    ])
  })
})

describe('retention prune', () => {
  const OLD = new Date('2026-01-01T00:00:00Z')
  const NEW = new Date('2026-03-01T00:00:00Z')
  const before = new Date('2026-02-01T00:00:00Z')

  let db: WfDb

  async function seed(args: {
    id: string
    createdAt?: Date
    status?: 'queued' | 'running' | 'done' | 'completed' | 'failed' | 'cancelled'
    isEval?: boolean
    parentRunId?: string
  }) {
    await db.insert(wfRun).values({
      id: args.id,
      workflowVersionId: 'v',
      triggerKind: 'manual',
      status: args.status ?? 'completed',
      isEval: args.isEval ?? false,
      parentRunId: args.parentRunId ?? null,
      createdAt: args.createdAt ?? OLD,
    })
    await db.insert(wfRunStep).values({
      runId: args.id,
      nodeId: 'node-1',
      nodeKind: 'agent',
      sequence: 1,
      status: 'completed',
    })
    await db
      .insert(wfRunLog)
      .values({ runId: args.id, level: 'info', message: 'hi', ts: 1 })
  }

  async function remainingRunIds() {
    const rows = await db.select({ id: wfRun.id }).from(wfRun).orderBy(wfRun.id)
    return rows.map((r) => r.id)
  }

  beforeEach(() => {
    db = freshDb()
  })

  test('deletes settled runs older than the cutoff, with their trace', async () => {
    await seed({ id: 'completed' })
    await seed({ id: 'failed', status: 'failed' })
    await seed({ id: 'cancelled', status: 'cancelled' })
    await seed({ id: 'recent', createdAt: NEW })

    expect(await pruneRuns(db, { before, limit: 10 })).toEqual({
      runs: 3,
      remaining: 0,
    })

    expect(await remainingRunIds()).toEqual(['recent'])
    const steps = await db.select().from(wfRunStep)
    expect(steps.map((s) => s.runId)).toEqual(['recent'])
    const logs = await db.select().from(wfRunLog)
    expect(logs.map((l) => l.runId)).toEqual(['recent'])
  })

  test('keeps eval runs and unsettled runs', async () => {
    await seed({ id: 'eval', isEval: true })
    await seed({ id: 'queued', status: 'queued' })
    await seed({ id: 'running', status: 'running' })
    // `done` still has arms of the graph executing.
    await seed({ id: 'done', status: 'done' })

    await pruneRuns(db, { before, limit: 10 })

    expect(await remainingRunIds()).toEqual([
      'done',
      'eval',
      'queued',
      'running',
    ])
  })

  test('keeps a settled run whose parent or child is live', async () => {
    await seed({ id: 'live-parent', status: 'running' })
    await seed({ id: 'settled-child', parentRunId: 'live-parent' })
    await seed({ id: 'settled-parent' })
    await seed({
      id: 'live-child',
      status: 'running',
      parentRunId: 'settled-parent',
    })

    expect(await pruneRuns(db, { before, limit: 10 })).toEqual({
      runs: 0,
      remaining: 0,
    })

    expect(await remainingRunIds()).toEqual([
      'live-child',
      'live-parent',
      'settled-child',
      'settled-parent',
    ])
  })

  test('pages oldest first and reports what remains', async () => {
    await seed({ id: 'older', createdAt: new Date('2025-01-01T00:00:00Z') })
    await seed({ id: 'newer', createdAt: OLD })

    expect(await pruneRuns(db, { before, limit: 1 })).toEqual({
      runs: 1,
      remaining: 1,
    })
    expect(await remainingRunIds()).toEqual(['newer'])
  })

  test('a page larger than one id chunk deletes every run', async () => {
    for (let i = 0; i < 95; i++) await seed({ id: `run-${i}` })

    expect(await pruneRuns(db, { before, limit: 100 })).toEqual({
      runs: 95,
      remaining: 0,
    })
    expect(await remainingRunIds()).toEqual([])
  })

  test('unlinks feedback rather than deleting it', async () => {
    await seed({ id: 'rated' })
    await db
      .insert(wfFeedback)
      .values({ subjectId: 's', runId: 'rated', rating: 'up' })

    await pruneRuns(db, { before, limit: 10 })

    const feedback = await db.select().from(wfFeedback)
    expect(feedback.map((f) => f.runId)).toEqual([null])
  })

  test('the preview counts what a prune removes and deletes nothing', async () => {
    await seed({ id: 'old-1' })
    await seed({ id: 'old-2' })
    await seed({ id: 'recent', createdAt: NEW })
    await seed({ id: 'eval', isEval: true })
    await db
      .insert(wfFeedback)
      .values({ subjectId: 's', runId: 'old-1', rating: 'up' })

    expect(await previewRunPrune(db, { before })).toEqual({
      runs: 2,
      steps: 2,
      logs: 2,
      feedbackUnlinked: 1,
    })
    expect(await remainingRunIds()).toEqual([
      'eval',
      'old-1',
      'old-2',
      'recent',
    ])
  })
})
