import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import type { AgentConfig, WorkflowGraph } from '../engine/graph'
import type { WfDb } from '../storage/client'
import {
  createAgent,
  createWorkflow,
  findWorkflowByName,
  publishAgent,
  saveVersion,
} from '../storage/data'
import { wfSchema } from '../storage/schema'

import { evalWrapperName, resolveEvalTarget } from './wrapper'

// Fix for the version pin that never was. A Goal's `targetVersion` was stored,
// rendered in the UI as "pinned v3", and frozen into every result's snapshot —
// but never reached `resolveEvalTarget`, so the eval graded LATEST regardless.
// These run against a real migrated database because the whole bug lived in the
// db-backed half of the resolver, which the pure builder tests can't reach.

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../migrations', import.meta.url),
)

function freshDb(): WfDb {
  const sqlite = new Database(':memory:')
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const f of files) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${f}`, 'utf8')
    for (const stmt of sql.split('--> statement-breakpoint')) {
      const trimmed = stmt.trim()
      if (trimmed) sqlite.run(trimmed)
    }
  }
  return drizzle(sqlite, { schema: wfSchema }) as unknown as WfDb
}

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

/** A minimal valid graph for a workflow target — trigger → output. */
function trivialGraph(): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      {
        id: 'trigger',
        kind: 'trigger',
        label: 'Manual start',
        position: { x: 0, y: 0 },
        informUser: { mode: 'off' },
        config: { triggerKind: 'manual' },
      },
      {
        id: 'output',
        kind: 'output',
        label: 'Output',
        position: { x: 280, y: 0 },
        informUser: { mode: 'off' },
        config: { source: { kind: 'ref', nodeId: 'trigger', path: '' } },
      },
    ],
    edges: [
      { id: 'e', source: 'trigger', target: 'output', condition: null },
    ],
  } as unknown as WorkflowGraph
}

/** An agent with two published versions (v1 from create, v2 from publish). */
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
      { kind: 'agent', id: agentId, version: 2 },
      'manual',
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
      { kind: 'agent', id: agentId, version: 9 },
      'manual',
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
      { kind: 'agent', id: agentId, version: 1 },
      'manual',
    )
    const v2 = await resolveEvalTarget(
      db,
      { kind: 'agent', id: agentId, version: 2 },
      'manual',
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
      { kind: 'agent', id: agentId, version: 2 },
      'manual',
    )
    const second = await resolveEvalTarget(
      db,
      { kind: 'agent', id: agentId, version: 2 },
      'manual',
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
      { kind: 'agent', id: agentId },
      'manual',
    )
    expect(resolved.workflowVersionId).toBeTruthy()
    expect(await findWorkflowByName(db, evalWrapperName(agentId))).not.toBeNull()
  })
})

describe('resolveEvalTarget — workflow version pin', () => {
  async function workflowWithTwoVersions(db: WfDb) {
    const created = await createWorkflow(db, {
      name: 'Pinned workflow',
      graph: trivialGraph(),
    })
    const v2 = await saveVersion(db, {
      workflowId: created.workflowId,
      graph: trivialGraph(),
    })
    return { workflowId: created.workflowId, v1: created.versionId, v2: v2.versionId }
  }

  test('a pinned goal grades the pinned version, not the latest', async () => {
    const db = freshDb()
    const { workflowId, v1, v2 } = await workflowWithTwoVersions(db)

    const pinned = await resolveEvalTarget(
      db,
      { kind: 'workflow', id: workflowId, version: 1 },
      'manual',
    )
    expect(pinned.workflowVersionId).toBe(v1)
    expect(pinned.workflowVersionId).not.toBe(v2)
  })

  test('an unpinned goal floats to the latest version', async () => {
    const db = freshDb()
    const { workflowId, v2 } = await workflowWithTwoVersions(db)

    const floating = await resolveEvalTarget(
      db,
      { kind: 'workflow', id: workflowId },
      'manual',
    )
    expect(floating.workflowVersionId).toBe(v2)
  })

  test('a pin that was never published throws', async () => {
    const db = freshDb()
    const { workflowId } = await workflowWithTwoVersions(db)

    const err = await resolveEvalTarget(
      db,
      { kind: 'workflow', id: workflowId, version: 3 },
      'manual',
    ).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err?.message).toContain('v3')
  })
})
