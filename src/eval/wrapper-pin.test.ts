import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import type { AgentConfig } from '../engine/graph'
import type { WfDb } from '../storage/client'
import {
  createAgent,
  createWorkflow,
  findWorkflowByName,
  publishAgent,
} from '../storage/data'
import { freshDb } from '../storage/db-test-helpers'
import { wfWorkflow } from '../storage/schema'

import {
  buildAgentWrapperGraph,
  ensureAgentEvalWrapper,
  evalWrapperName,
  resolveEvalTarget,
} from './wrapper'

// Fix for the version pin that never was. A Goal's `targetVersion` was stored,
// rendered in the UI as "pinned v3", and frozen into every result's snapshot —
// but never reached `resolveEvalTarget`, so the eval graded LATEST regardless.
// These run against a real migrated database because the whole bug lived in the
// db-backed half of the resolver, which the pure builder tests can't reach.

function config(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    modelId: 'test-model',
    prompt: 'You are a test agent.',
    userPrompt: 'Do the thing: ${input}',
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
    ...over,
  } as AgentConfig
}

async function agentWithTwoVersions(db: WfDb) {
  const { agentId } = await createAgent(db, {
    name: 'Pinned agent',
    config: config(),
  })
  await publishAgent(db, { agentId, config: config({ maxTurns: 9 }) })
  return agentId
}

describe('resolveEvalTarget — agent version pin', () => {
  test('a pinned goal resolves, and its wrapper is named for the pin', async () => {
    const db = freshDb()
    const agentId = await agentWithTwoVersions(db)

    const resolved = await resolveEvalTarget(
      db,
      { id: agentId, version: 2 },
    )
    expect(resolved.triggerKind).toBe('manual')

    const wrapper = await findWorkflowByName(db, evalWrapperName(agentId, 2))
    expect(wrapper).not.toBeNull()
  })

  test('a pin that was never published throws, naming the pin', async () => {
    const db = freshDb()
    const agentId = await agentWithTwoVersions(db)

    // The message is literally what a user reads in the report's error banner,
    // so its shape is part of the contract, not an implementation detail.
    const err = await resolveEvalTarget(
      db,
      { id: agentId, version: 9 },
    ).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err).not.toBeNull()
    expect(err?.message).toContain('v9')
    expect(err?.message).toContain(agentId)
  })

  test('two pins of one agent get two separate wrappers', async () => {
    const db = freshDb()
    const agentId = await agentWithTwoVersions(db)

    const v1 = await resolveEvalTarget(
      db,
      { id: agentId, version: 1 },
    )
    const v2 = await resolveEvalTarget(
      db,
      { id: agentId, version: 2 },
    )
    // Sharing a cached wrapper across pins is precisely how the pin would be
    // silently lost again.
    expect(v1.workflowVersionId).not.toBe(v2.workflowVersionId)
  })

  test('resolving the same pin twice is stable — no republish-forever', async () => {
    const db = freshDb()
    const agentId = await agentWithTwoVersions(db)

    const first = await resolveEvalTarget(
      db,
      { id: agentId, version: 2 },
    )
    const second = await resolveEvalTarget(
      db,
      { id: agentId, version: 2 },
    )
    // `ensureAgentEvalWrapper` rebuilds and structurally compares the graph on
    // every call. If a pinned graph didn't compare equal to its stored copy,
    // every eval cell would publish a new wrapper version.
    expect(second.workflowVersionId).toBe(first.workflowVersionId)
  })

  test('an unpinned goal still floats to latest under the historic name', async () => {
    const db = freshDb()
    const agentId = await agentWithTwoVersions(db)

    const resolved = await resolveEvalTarget(
      db,
      { id: agentId },
    )
    expect(resolved.workflowVersionId).toBeTruthy()
    expect(await findWorkflowByName(db, evalWrapperName(agentId))).not.toBeNull()
  })
})

describe('ensureAgentEvalWrapper — concurrent first calls', () => {
  test('racing first calls create one wrapper and agree on its version', async () => {
    const db = freshDb()
    const agentId = await agentWithTwoVersions(db)

    const results = await Promise.all(
      Array.from({ length: 5 }, () => {
        return ensureAgentEvalWrapper(db, { agentId })
      }),
    )

    const rows = await db
      .select({ id: wfWorkflow.id })
      .from(wfWorkflow)
      .where(eq(wfWorkflow.name, evalWrapperName(agentId)))
    expect(rows).toHaveLength(1)
    expect(new Set(results.map((r) => r.workflowVersionId)).size).toBe(1)
  })

  test('a wrapper created before ids were derived is still reused', async () => {
    const db = freshDb()
    const agentId = await agentWithTwoVersions(db)
    const legacy = await createWorkflow(db, {
      name: evalWrapperName(agentId),
      hidden: true,
      graph: buildAgentWrapperGraph(agentId),
    })

    const resolved = await ensureAgentEvalWrapper(db, { agentId })
    expect(resolved).toEqual({
      workflowId: legacy.workflowId,
      workflowVersionId: legacy.versionId,
    })
  })
})
