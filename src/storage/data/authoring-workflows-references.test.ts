import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import type { AgentConfig, WorkflowGraph } from '../../engine/graph'
import { evalWrapperName } from '../../engine/eval-wrapper-name'
import type { WfDb } from '../client'
import { freshDb } from '../db-test-helpers'
import {  wfWorkflow } from '../schema'

import { createAgent } from './authoring-agents'
import { createWorkflow } from './authoring-workflows'
import {
  countWorkflowsReferencingAgent,
  listWorkflowsReferencingAllAgents,
  listWorkflowsReferencingAgent,
} from './authoring-workflows-references'

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
        reasoning: false,
        webSearch: 'off',
        webCitations: false,
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

  async function addWorkflow(
    name: string,
    opts: { archived?: boolean; hidden?: boolean } = {},
  ) {
    const { workflowId: id } = await createWorkflow(db, {
      name,
      graph: graphUsing(agentId),
      hidden: opts.hidden,
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

  test('a hidden eval wrapper is not counted as usage', async () => {
    await addWorkflow('Ingest recipe document')
    await addWorkflow(evalWrapperName(agentId), { hidden: true })

    // The wrapper's graph names the agent, but it is machinery the Workflows
    // list hides — counting it would show usage pointing at nothing clickable.
    expect(await countWorkflowsReferencingAgent(db, { agentId })).toBe(1)
    expect(
      (await listWorkflowsReferencingAgent(db, { agentId })).map((w) => w.name),
    ).toEqual(['Ingest recipe document'])
  })

  test('an agent used only by its eval wrapper reads as unused', async () => {
    await addWorkflow(evalWrapperName(agentId), { hidden: true })

    // This is what lets the agent be archived. A wrapper is regenerated from
    // its eval set, so there is nothing to "disconnect first" — holding the
    // archive guard open on one makes the agent undeletable from the UI.
    expect(await countWorkflowsReferencingAgent(db, { agentId })).toBe(0)
    expect(await listWorkflowsReferencingAgent(db, { agentId })).toEqual([])
  })

  test('the all-agents map excludes hidden workflows too', async () => {
    await addWorkflow('Ingest recipe document')
    await addWorkflow(evalWrapperName(agentId), { hidden: true })

    const byAgent = await listWorkflowsReferencingAllAgents(db)
    expect(byAgent.get(agentId)?.map((w) => w.name)).toEqual([
      'Ingest recipe document',
    ])
  })
})
