import { describe, expect, test } from 'bun:test'

import { buildStarterGraph } from '../../engine'
import { createRun, createWorkflow, getWorkflow } from '../../storage/data'
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
