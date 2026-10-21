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
