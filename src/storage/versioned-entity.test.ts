import { describe, expect, test } from 'bun:test'

import { buildStarterGraph } from '../engine'

import { createWorkflow, saveVersion, StaleBaseError } from './data'
import { freshDb } from './db-test-helpers'

describe('publish expectedVersionNumber', () => {
  test('two publishes on the same base: one lands, the other is stale', async () => {
    const db = freshDb()
    const graph = buildStarterGraph({ mode: 'manual' })
    const { workflowId } = await createWorkflow(db, {
      name: 'W',
      createdBy: 'tester',
      graph,
    })
    const results = await Promise.allSettled([
      saveVersion(db, { workflowId, graph, expectedVersionNumber: 1 }),
      saveVersion(db, { workflowId, graph, expectedVersionNumber: 1 }),
    ])
    const ok = results.filter((r) => r.status === 'fulfilled')
    const refused = results.filter((r) => r.status === 'rejected')
    expect(ok).toHaveLength(1)
    expect(refused).toHaveLength(1)
    expect((refused[0]).reason).toBeInstanceOf(
      StaleBaseError,
    )
  })

  test('no expectation keeps the old behavior', async () => {
    const db = freshDb()
    const graph = buildStarterGraph({ mode: 'manual' })
    const { workflowId } = await createWorkflow(db, {
      name: 'W',
      createdBy: 'tester',
      graph,
    })
    const out = await saveVersion(db, { workflowId, graph })
    expect(out.versionNumber).toBe(2)
  })
})
