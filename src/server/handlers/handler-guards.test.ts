import { describe, expect, test } from 'bun:test'

import { buildStarterGraph } from '../../engine'
import { evalWrapperName } from '../../eval'
import {
  createEvalRun,
  createEvalSet,
  createRun,
  createWorkflow,
  findWorkflowByName,
  getWorkflow,
  upsertEvalRow,
} from '../../storage/data'
import { freshDb } from '../../storage/db-test-helpers'

import { buildEvalHandlers } from './evals'
import { testHandlerCtx, testHandlerOptions } from './handler-test-helpers'
import { buildRunHandlers } from './runs'

// Guards that used to live only in the MCP tools, now in the handlers so the
// editor and any HTTP client get them too.

describe('eval set target', () => {
  test('creating a goal on a target that does not exist is refused', async () => {
    const db = freshDb()
    const h = buildEvalHandlers(testHandlerOptions())
    await expect(
      h.createEvalSet(
        testHandlerCtx(db, {
          name: 'Goals',
          targetKind: 'agent',
          targetId: 'ghost',
          triggerKind: 'manual',
        }),
      ),
    ).rejects.toThrow(/No agent found for id ghost/)
  })
})

describe('startEvalRun on a goal whose target agent is gone', () => {
  test('is refused before the host hook runs or a wrapper is created', async () => {
    const db = freshDb()
    const setId = await createEvalSet(db, {
      name: 'Old goal',
      targetKind: 'agent',
      targetId: 'gone',
      targetVersion: null,
      triggerKind: 'manual',
    })
    const rowId = await upsertEvalRow(db, { setId, name: 'Sample' })
    const evalRunId = await createEvalRun(db, { setIds: [setId], total: 1 })
    let called = false
    const h = buildEvalHandlers(
      testHandlerOptions({
        startEvalRun: async () => {
          called = true
          return { wfRunId: 'new' }
        },
      }),
    )
    await expect(
      h.startEvalRun(testHandlerCtx(db, { evalRunId, rowId })),
    ).rejects.toThrow(/No agent found for id gone/)
    expect(called).toBe(false)
    expect(await findWorkflowByName(db, evalWrapperName('gone'))).toBeNull()
  })
})

describe('retryRun', () => {
  test('a run still in flight is refused before the host hook runs', async () => {
    const db = freshDb()
    const { workflowId } = await createWorkflow(db, {
      name: 'W',
      createdBy: 'tester',
      graph: buildStarterGraph({ mode: 'manual' }),
    })
    const versionId = (await getWorkflow(db, workflowId))!.currentVersion!.id
    const runId = await createRun(db, {
      workflowVersionId: versionId,
      triggerKind: 'manual',
    })
    let called = false
    const h = buildRunHandlers(
      testHandlerOptions({
        retryRun: async () => {
          called = true
          return { runId: 'new' }
        },
      }),
    )
    await expect(h.retryRun(testHandlerCtx(db, { runId }))).rejects.toThrow(
      /still (queued|running)/,
    )
    expect(called).toBe(false)
  })
})
