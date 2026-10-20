import { MockLanguageModelV3 } from 'ai/test'
import type { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import { makeAgentConfig } from '../engine/agent-test-helpers'
import type { WfSdkConfig } from '../engine/config'
import type { AgentConfig } from '../engine/graph'
import { mockFinish, mockUsage } from '../engine/model-test-helpers'
import type { WfDb } from '../storage/client'
import { createAgent, listAgentCalls } from '../storage/data'
import { freshDb } from '../storage/db-test-helpers'
import { wfRun, wfSchema, wfWorkflow, wfWorkflowVersion } from '../storage/schema'

import { runAgent } from './run-agent'

// What app code is promised: the answer comes back, and the call is a real,
// recorded run — not a playground preview nobody can find afterwards.

const CONFIG: AgentConfig = makeAgentConfig({
  modelId: 'mock',
  prompt: 'Estimate.',
  userPrompt: 'Lines: ${lines}',
  inputKind: 'task' as const,
  toolIds: [],
  maxTurns: 1,
  output: {
    kind: 'object',
    schema: {
      type: 'object',
      properties: { grams: { type: 'number' } },
      required: ['grams'],
      additionalProperties: false,
    },
  },
})

function fakeConfig(opts: {
  seen?: { prompt?: unknown; signal?: AbortSignal }
  hang?: boolean
  hooks?: Pick<
    WfSdkConfig<Record<string, never>>,
    'onRunComplete' | 'onRunFailed'
  >
}): WfSdkConfig<Record<string, never>> {
  return {
    ...opts.hooks,
    getModel: () => {
      return new MockLanguageModelV3({
        doGenerate: async (o) => {
          if (opts.seen) {
            opts.seen.prompt = o.prompt
            opts.seen.signal = o.abortSignal
          }
          // Hangs until aborted — as a stalled provider does when the call's
          // signal is honoured.
          if (opts.hang) {
            await new Promise((_, reject) => {
              o.abortSignal?.addEventListener('abort', () => {
                reject(new Error('aborted'))
              })
            })
          }
          return {
            content: [{ type: 'text', text: '{"grams":75}' }],
            finishReason: mockFinish('stop'),
            usage: mockUsage(1, 1),
            warnings: [],
          }
        },
      })
    },
    toolRegistry: new Map(),
    triggers: {},
    buildRunDeps: () => ({}),
  } as unknown as WfSdkConfig<Record<string, never>>
}

async function seedAgent(db: WfDb): Promise<string> {
  const { agentId } = await createAgent(db, {
    name: 'Estimate',
    slug: 'estimate',
    config: CONFIG,
  })
  return agentId
}

describe('runAgent', () => {
  test('returns the object and records the call as a run', async () => {
    const db = freshDb()
    const agentId = await seedAgent(db)
    const seen: { prompt?: unknown } = {}

    const result = await runAgent({
      db,
      wfConfig: fakeConfig({ seen }),
      env: {},
      slug: 'estimate',
      promptVariables: { lines: '3 ice cubes' },
      hostContext: { caller: 'test' },
    })

    expect(result.output).toEqual({ grams: 75 })
    // The task agent's own userPrompt, rendered from the variables.
    expect(JSON.stringify(seen.prompt)).toContain('Lines: 3 ice cubes')

    const [run] = await db
      .select()
      .from(wfRun)
      .where(eq(wfRun.id, result.workflowRunId))
    expect(run.status).toBe('completed')
    expect(run.isEval).toBe(false)
    expect(run.triggerKind).toBe('manual')
    expect(run.hostContext).toEqual({ caller: 'test' })

    // Visible where an agent's calls are read.
    const calls = await listAgentCalls(db, { agentId })
    expect(calls.map((c) => c.runId)).toEqual([result.workflowRunId])
  })

  test('reuses the wrapper version across calls', async () => {
    const db = freshDb()
    await seedAgent(db)
    const call = () => {
      return runAgent({
        db,
        wfConfig: fakeConfig({}),
        env: {},
        slug: 'estimate',
        promptVariables: { lines: 'x' },
      })
    }
    await call()
    const versions = (await db.select().from(wfWorkflowVersion)).length
    await call()
    expect((await db.select().from(wfWorkflowVersion)).length).toBe(versions)
  })

  test('throws for an unknown slug', async () => {
    const db = freshDb()
    expect(
      runAgent({
        db,
        wfConfig: fakeConfig({}),
        env: {},
        slug: 'nope',
        promptVariables: {},
      }),
    ).rejects.toThrow('no agent with slug "nope"')
  })

  test('gives up at the timeout and records the run as failed', async () => {
    const db = freshDb()
    await seedAgent(db)

    const error = await runAgent({
      db,
      wfConfig: fakeConfig({ hang: true }),
      env: {},
      slug: 'estimate',
      promptVariables: { lines: 'x' },
      timeoutMs: 50,
    }).catch((err: unknown) => err)

    expect(String(error)).toContain('timed out after 50ms')
    const [run] = await db.select().from(wfRun)
    expect(run.status).toBe('failed')
  })

  test('aborts the provider call shortly after the deadline', async () => {
    const db = freshDb()
    await seedAgent(db)
    const seen: { signal?: AbortSignal } = {}

    await runAgent({
      db,
      wfConfig: fakeConfig({ hang: true, seen }),
      env: {},
      slug: 'estimate',
      promptVariables: { lines: 'x' },
      timeoutMs: 50,
    }).catch(() => undefined)

    // Not left running behind the caller: the agent's budget is the call's
    // deadline (plus a short grace), not the node's 30s floor.
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(seen.signal?.aborted).toBe(true)
  })

  test('host hooks fire after the run row records the outcome', async () => {
    const db = freshDb()
    await seedAgent(db)
    const statuses: string[] = []
    const statusOf = async (runId: string | undefined) => {
      const [run] = await db
        .select({ status: wfRun.status })
        .from(wfRun)
        .where(eq(wfRun.id, runId ?? ''))
      statuses.push(run.status)
    }
    const hooks = {
      onRunComplete: (ctx: { runId?: string }) => statusOf(ctx.runId),
      onRunFailed: (_: unknown, f: { workflowRunId?: string }) => {
        return statusOf(f.workflowRunId)
      },
    }

    await runAgent({
      db,
      wfConfig: fakeConfig({ hooks }),
      env: {},
      slug: 'estimate',
      promptVariables: { lines: 'x' },
    })
    await runAgent({
      db,
      wfConfig: fakeConfig({ hooks, hang: true }),
      env: {},
      slug: 'estimate',
      promptVariables: { lines: 'x' },
      timeoutMs: 50,
    }).catch(() => undefined)

    expect(statuses).toEqual(['completed', 'failed'])
  })

  test('a fresh handle over the same database reuses the cached wrapper', async () => {
    const db = freshDb()
    await seedAgent(db)
    const call = (handle: WfDb) => {
      return runAgent({
        db: handle,
        wfConfig: fakeConfig({}),
        env: {},
        slug: 'estimate',
        promptVariables: { lines: 'x' },
      })
    }
    await call(db)
    // With the wrapper's workflow row gone, only a cache hit can still run —
    // a miss would go through `ensureAgentEvalWrapper` and recreate the row.
    await db.delete(wfWorkflow)
    // A request mints a fresh drizzle wrapper over the same driver.
    const sameDriver = drizzle((db as unknown as { $client: Database }).$client, {
      schema: wfSchema,
    }) as unknown as WfDb
    await call(sameDriver)
    expect(await db.select().from(wfWorkflow)).toHaveLength(0)
  })
})
