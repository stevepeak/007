import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'

import type { WfDb } from '../client'
import {
  wfModel,
  wfRun,
  wfRunStep,
  wfSchema,
  wfWorkflow,
  wfWorkflowVersion,
} from '../schema'

import { listAgentCalls } from './runs-agents'

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

const AGENT = 'agent-1'
const OTHER_AGENT = 'agent-2'
const MODEL = 'gpt-test'
// The graph node that points at AGENT — the attribution path for steps recorded
// before `meta.agentId` existed.
const AGENT_NODE = 'node-agent-1'
const VERSION = 'version-1'

/** An agent step's recorded meta: two turns, three tool calls, 1.5k tokens. */
function agentMeta(extra: Record<string, unknown> = {}) {
  return {
    model: MODEL,
    systemPrompt: 'be useful',
    steps: [
      {
        stepNumber: 1,
        toolCalls: [
          { toolCallId: '1', toolName: 'search', input: {}, output: {} },
          { toolCallId: '2', toolName: 'search', input: {}, output: {} },
        ],
      },
      {
        stepNumber: 2,
        toolCalls: [
          { toolCallId: '3', toolName: 'calculator', input: {}, output: {} },
        ],
      },
    ],
    totalUsage: { inputTokens: 1000, outputTokens: 500 },
    ...extra,
  }
}

async function seed(db: WfDb) {
  await db.insert(wfWorkflow).values({ id: 'wf-1', name: 'Intake' })
  await db.insert(wfWorkflowVersion).values({
    id: VERSION,
    workflowId: 'wf-1',
    versionNumber: 3,
    graph: {
      nodes: [
        { id: AGENT_NODE, kind: 'agent', config: { agentId: AGENT } },
        {
          id: 'node-agent-2',
          kind: 'agent',
          config: { agentId: OTHER_AGENT },
        },
      ],
      edges: [],
    },
  })
  await db.insert(wfModel).values({
    id: `test:${MODEL}`,
    providerId: 'test',
    modelId: MODEL,
    label: 'Test model',
    promptPricePerMTok: 1,
    completionPricePerMTok: 2,
  })
}

async function addRun(
  db: WfDb,
  id: string,
  opts: { isEval?: boolean; createdAt: Date },
) {
  await db.insert(wfRun).values({
    id,
    workflowVersionId: VERSION,
    triggerKind: 'chat',
    status: 'completed',
    isEval: opts.isEval ?? false,
    createdAt: opts.createdAt,
  })
}

describe('listAgentCalls', () => {
  let db: WfDb

  beforeEach(async () => {
    db = freshDb()
    await seed(db)
  })

  test('attributes a call by its stamped meta.agentId and derives metrics', async () => {
    await addRun(db, 'run-1', { createdAt: new Date(1000) })
    await db.insert(wfRunStep).values({
      runId: 'run-1',
      // A spawned sub-agent: no graph node of its own, so only the stamp can
      // attribute it.
      nodeId: 'sub:node-agent-2:0',
      nodeKind: 'agent',
      sequence: 0,
      status: 'completed',
      meta: agentMeta({
        agentId: AGENT,
        agentVersion: 7,
        subAgentName: 'Researcher',
      }),
      startedAt: new Date(1000),
      finishedAt: new Date(4000),
    })

    const [call, ...rest] = await listAgentCalls(db, { agentId: AGENT })
    expect(rest).toHaveLength(0)
    expect(call.runId).toBe('run-1')
    expect(call.workflowName).toBe('Intake')
    expect(call.versionNumber).toBe(3)
    expect(call.turns).toBe(2)
    expect(call.inputTokens).toBe(1000)
    expect(call.outputTokens).toBe(500)
    // 1000 prompt tokens @ $1/Mtok + 500 completion @ $2/Mtok.
    expect(call.costUsd).toBeCloseTo(0.002, 10)
    expect(call.toolCalls).toEqual([
      { toolId: 'search', count: 2 },
      { toolId: 'calculator', count: 1 },
    ])
    expect(call.durationMs).toBe(3000)
    expect(call.agentVersion).toBe(7)
    expect(call.subAgentName).toBe('Researcher')
    // Not a fan-out: one execution, no iteration items behind it.
    expect(call.callCount).toBe(1)
    expect(call.itemIndexes).toEqual([])
    expect(call.failedCount).toBe(0)
  })

  test('attributes an unstamped call by the node it ran on', async () => {
    await addRun(db, 'run-1', { createdAt: new Date(1000) })
    await db.insert(wfRunStep).values({
      runId: 'run-1',
      nodeId: AGENT_NODE,
      nodeKind: 'agent',
      sequence: 0,
      status: 'completed',
      // Recorded before the stamp existed — no agentId in meta.
      meta: agentMeta(),
      startedAt: new Date(1000),
    })

    const calls = await listAgentCalls(db, { agentId: AGENT })
    expect(calls).toHaveLength(1)
    expect(calls[0].nodeId).toBe(AGENT_NODE)
    expect(calls[0].agentVersion).toBeNull()
  })

  test('excludes other agents, non-agent steps, and eval runs', async () => {
    await addRun(db, 'run-1', { createdAt: new Date(1000) })
    await addRun(db, 'run-eval', { isEval: true, createdAt: new Date(2000) })
    await db.insert(wfRunStep).values([
      {
        runId: 'run-1',
        nodeId: 'node-agent-2',
        nodeKind: 'agent',
        sequence: 0,
        status: 'completed',
        meta: agentMeta({ agentId: OTHER_AGENT }),
      },
      {
        runId: 'run-1',
        nodeId: 'node-tool',
        nodeKind: 'tool',
        sequence: 1,
        status: 'completed',
        meta: { toolId: 'search' },
      },
      {
        runId: 'run-eval',
        nodeId: AGENT_NODE,
        nodeKind: 'agent',
        sequence: 0,
        status: 'completed',
        meta: agentMeta({ agentId: AGENT }),
      },
    ])

    // The only step attributable to AGENT ran in an eval — simulated, so it is
    // never counted, with no opt-in to bring it back.
    expect(await listAgentCalls(db, { agentId: AGENT })).toHaveLength(0)
  })

  test('returns newest first and honours the limit', async () => {
    for (const [i, ts] of [1000, 2000, 3000].entries()) {
      await addRun(db, `run-${i}`, { createdAt: new Date(ts) })
      await db.insert(wfRunStep).values({
        runId: `run-${i}`,
        nodeId: AGENT_NODE,
        nodeKind: 'agent',
        sequence: 0,
        status: 'completed',
        meta: agentMeta({ agentId: AGENT }),
        startedAt: new Date(ts),
      })
    }

    const calls = await listAgentCalls(db, { agentId: AGENT, limit: 2 })
    expect(calls.map((c) => c.runId)).toEqual(['run-2', 'run-1'])
  })

  test('folds an iteration fan-out into one row with summed metrics', async () => {
    await addRun(db, 'run-1', { createdAt: new Date(1000) })
    // The same agent node, run once per item of an enclosing iteration — five
    // steps that are ONE call site, not five rows in the editor.
    await db.insert(wfRunStep).values(
      Array.from({ length: 5 }, (_, i) => ({
        runId: 'run-1',
        nodeId: AGENT_NODE,
        nodeKind: 'agent',
        itemIndex: i,
        sequence: i,
        status: i === 3 ? 'failed' : 'completed',
        error: i === 3 ? 'item blew up' : null,
        meta: agentMeta({ agentId: AGENT }),
        startedAt: new Date(1000 + i * 1000),
        finishedAt: new Date(2000 + i * 1000),
      })),
    )

    const calls = await listAgentCalls(db, { agentId: AGENT })
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call.callCount).toBe(5)
    expect(call.itemIndexes).toEqual([0, 1, 2, 3, 4])
    // Metrics are the TOTAL across the fan-out — 2 turns and 1.5k tokens each.
    expect(call.turns).toBe(10)
    expect(call.inputTokens).toBe(5000)
    expect(call.outputTokens).toBe(2500)
    expect(call.costUsd).toBeCloseTo(0.01, 10)
    expect(call.toolCalls).toEqual([
      { toolId: 'search', count: 10 },
      { toolId: 'calculator', count: 5 },
    ])
    // Summed compute (5 × 1s), not the wall-clock span of the fan-out.
    expect(call.durationMs).toBe(5000)
    expect(call.startedAt).toBe(1000)
    expect(call.finishedAt).toBe(6000)
    // One failed item speaks for the whole row.
    expect(call.status).toBe('failed')
    expect(call.failedCount).toBe(1)
    expect(call.error).toBe('item blew up')
  })

  test('keeps two nodes in the same run as separate call sites', async () => {
    await addRun(db, 'run-1', { createdAt: new Date(1000) })
    await db.insert(wfRunStep).values([
      {
        runId: 'run-1',
        nodeId: AGENT_NODE,
        nodeKind: 'agent',
        sequence: 0,
        status: 'completed',
        meta: agentMeta({ agentId: AGENT }),
        startedAt: new Date(1000),
      },
      {
        runId: 'run-1',
        // The same agent placed twice in the graph — two call sites, so two
        // rows, even though they share a run.
        nodeId: 'node-agent-1b',
        nodeKind: 'agent',
        sequence: 1,
        status: 'completed',
        meta: agentMeta({ agentId: AGENT }),
        startedAt: new Date(2000),
      },
    ])

    const calls = await listAgentCalls(db, { agentId: AGENT })
    expect(calls.map((c) => c.nodeId)).toEqual(['node-agent-1b', AGENT_NODE])
    expect(calls.every((c) => c.callCount === 1)).toBe(true)
  })

  test('an unpriced model yields tokens but no cost', async () => {
    await addRun(db, 'run-1', { createdAt: new Date(1000) })
    await db.insert(wfRunStep).values({
      runId: 'run-1',
      nodeId: AGENT_NODE,
      nodeKind: 'agent',
      sequence: 0,
      status: 'failed',
      error: 'boom',
      meta: agentMeta({ agentId: AGENT, model: 'uncatalogued' }),
    })

    const [call] = await listAgentCalls(db, { agentId: AGENT })
    expect(call.inputTokens).toBe(1000)
    expect(call.costUsd).toBeNull()
    expect(call.status).toBe('failed')
    expect(call.error).toBe('boom')
    // No step timing recorded — the run's own creation time stands in so the
    // row can still say when it happened.
    expect(call.startedAt).toBe(1000)
    expect(call.durationMs).toBeNull()
  })
})
