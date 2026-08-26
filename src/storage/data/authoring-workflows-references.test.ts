import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import type { AgentConfig, WorkflowGraph } from '../../engine/graph'
import type { WfDb } from '../client'
import { wfSchema, wfWorkflow } from '../schema'

import { createAgent } from './authoring-agents'
import { createWorkflow } from './authoring-workflows'
import {
  countWorkflowsReferencingAgent,
  listWorkflowsReferencingAllAgents,
  listWorkflowsReferencingAgent,
} from './authoring-workflows-references'

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../migrations', import.meta.url),
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

/** Trigger → one agent node → output: the smallest graph that references an agent. */
function graphUsing(agentId: string): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      {
        id: 'trigger',
        position: { x: 0, y: 0 },
        label: 'Start',
        kind: 'trigger',
        config: { triggerKind: 'manual' },
      },
      {
        id: 'call',
        position: { x: 200, y: 0 },
        label: 'Call agent',
        kind: 'agent',
        config: { agentId, version: null, inputs: {} },
      },
      {
        id: 'out',
        position: { x: 400, y: 0 },
        label: 'Done',
        kind: 'output',
        config: {},
      },
    ],
    edges: [
      { source: 'trigger', target: 'call' },
      { source: 'call', target: 'out' },
    ],
  } as unknown as WorkflowGraph
}

describe('agent workflow references', () => {
  let db: WfDb
  let agentId: string

  beforeEach(async () => {
    db = freshDb()
    const created = await createAgent(db, {
      name: 'Match existing recipe',
      config: {
        modelId: 'test-model',
        prompt: 'Decide whether this is a duplicate.',
        userPrompt: 'Recipe: ${recipe}',
        toolIds: [],
        maxTurns: 1,
        toolTokenBudget: null,
        answerReservePercent: 10,
        requireToolFirstTurn: false,
        inputKind: 'task',
        output: { kind: 'text' },
        subAgents: {
          targets: [],
          maxConcurrent: 4,
          maxSpawns: 10,
          allowStopSignal: true,
        },
      } satisfies AgentConfig,
    })
    agentId = created.agentId
  })

  async function addWorkflow(name: string, opts: { archived?: boolean } = {}) {
    const { workflowId: id } = await createWorkflow(db, {
      name,
      graph: graphUsing(agentId),
    })
    if (opts.archived) {
      await db
        .update(wfWorkflow)
        .set({ archived: true })
        .where(eq(wfWorkflow.id, id))
    }
    return id
  }

  test('counts a live workflow that references the agent', async () => {
    await addWorkflow('Ingest recipe document')
    expect(await countWorkflowsReferencingAgent(db, { agentId })).toBe(1)
  })

  test('an archived workflow is not counted as usage', async () => {
    await addWorkflow('Ingest recipe document')
    await addWorkflow('Ingest MEP document', { archived: true })

    // Two graphs name the agent, but only the live one is real usage.
    expect(await countWorkflowsReferencingAgent(db, { agentId })).toBe(1)
    expect(
      (await listWorkflowsReferencingAgent(db, { agentId })).map((w) => w.name),
    ).toEqual(['Ingest recipe document'])
  })

  test('an agent used only by an archived workflow reads as unused', async () => {
    await addWorkflow('Ingest MEP document', { archived: true })

    // This is what lets the agent be archived: a retired workflow must not
    // hold the archive guard open.
    expect(await countWorkflowsReferencingAgent(db, { agentId })).toBe(0)
    expect(await listWorkflowsReferencingAgent(db, { agentId })).toEqual([])
  })

  test('the all-agents map excludes archived workflows too', async () => {
    await addWorkflow('Ingest recipe document')
    await addWorkflow('Ingest MEP document', { archived: true })

    const byAgent = await listWorkflowsReferencingAllAgents(db)
    expect(byAgent.get(agentId)?.map((w) => w.name)).toEqual([
      'Ingest recipe document',
    ])
  })
})
