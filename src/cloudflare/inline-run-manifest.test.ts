import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { makeAgentConfig } from '../engine/agent-test-helpers'
import type { WfSdkConfig } from '../engine/config'
import { toManifestRefs, type WorkflowGraph } from '../engine/graph'
import { mockFinish, mockUsage } from '../engine/model-test-helpers'
import type { WfDb } from '../storage/client'
import {
  createAgent,
  publishAgent,
  resolveRunManifest,
  setRunManifest,
} from '../storage/data'
import {
  d1FromSqlite,
  migratedSqlite,
  wrapSqlite,
} from '../storage/db-test-helpers'
import { wfRun, wfWorkflow, wfWorkflowVersion } from '../storage/schema'

import type { GraphWorkflowEnv, GraphWorkflowParams } from './graph-workflow'
import { runInlineGraph, type InlineRunRoom } from './inline-run'

// A real walk over a real database: what a run stores, and which agent version
// it executes, when the manifest is refs and the content comes from the version.

function agentConfig(prompt: string) {
  return makeAgentConfig({
    modelId: 'mock',
    prompt,
    userPrompt: 'Go.',
    inputKind: 'task' as const,
    toolIds: [],
    maxTurns: 1,
    output: { kind: 'text' },
  })
}

function graphOf(agentId: string): WorkflowGraph {
  const shared = { position: { x: 0, y: 0 }, informUser: { mode: 'off' } }
  return {
    version: 1,
    nodes: [
      {
        ...shared,
        id: 't',
        kind: 'trigger',
        label: 'Start',
        config: { triggerKind: 'manual', engine: 'inline' },
      },
      {
        ...shared,
        id: 'a',
        kind: 'agent',
        label: 'Agent',
        config: { agentId, version: null, inputs: {} },
      },
      {
        ...shared,
        id: 'o',
        kind: 'output',
        label: 'Output',
        config: { source: { kind: 'ref', nodeId: 'a', path: '' } },
      },
    ],
    edges: [
      { id: 'e1', source: 't', target: 'a', condition: null },
      { id: 'e2', source: 'a', target: 'o', condition: null },
    ],
  } as WorkflowGraph
}

const ROOM: InlineRunRoom = {
  appendAnswer: () => {},
  waitForCallee: () => Promise.reject(new Error('no callee in this graph')),
  deliverCallee: () => {},
}

describe('runInlineGraph — the run manifest', () => {
  let db: WfDb
  let env: GraphWorkflowEnv
  let agentId: string
  // Every system prompt the model was called with, in order.
  let prompts: string[]
  let config: WfSdkConfig<unknown>

  beforeEach(async () => {
    const sqlite = migratedSqlite()
    db = wrapSqlite(sqlite)
    env = { WF_DB: d1FromSqlite(sqlite) } as unknown as GraphWorkflowEnv
    prompts = []
    config = {
      buildRunDeps: () => Promise.resolve({}),
      getModel: () => {
        return new MockLanguageModelV3({
          doStream: ({ prompt }) => {
            const [system] = prompt
            if (system?.role === 'system') prompts.push(system.content)
            return Promise.resolve({
              stream: simulateReadableStream({
                chunks: [
                  { type: 'text-start' as const, id: 't' },
                  { type: 'text-delta' as const, id: 't', delta: 'Answer.' },
                  { type: 'text-end' as const, id: 't' },
                  {
                    type: 'finish' as const,
                    finishReason: mockFinish('stop'),
                    usage: mockUsage(1, 1),
                  },
                ],
              }),
            })
          },
        })
      },
      toolRegistry: {},
      triggers: {},
    } as unknown as WfSdkConfig<unknown>
    ;({ agentId } = await createAgent(db, {
      name: 'Summarizer',
      config: agentConfig('prompt v1'),
    }))
    await db.insert(wfWorkflow).values({ id: 'wf-1', name: 'Root' })
    await db.insert(wfWorkflowVersion).values({
      id: 'wfv-1',
      workflowId: 'wf-1',
      versionNumber: 1,
      graph: graphOf(agentId),
    })
    await db.insert(wfRun).values({
      id: 'run-1',
      workflowVersionId: 'wfv-1',
      triggerKind: 'manual',
    })
  })

  function paramsFor(
    extra: Partial<GraphWorkflowParams> = {},
  ): GraphWorkflowParams {
    return {
      runId: 'room-1',
      workflowRunId: 'run-1',
      workflowVersionId: 'wfv-1',
      triggerInput: {},
      runContext: { triggerKind: 'manual', promptVariables: {} },
      ...extra,
    }
  }

  async function runRow() {
    const [row] = await db.select().from(wfRun).where(eq(wfRun.id, 'run-1'))
    return row
  }

  test('a top-level run stores refs and executes the resolved version', async () => {
    await runInlineGraph(config, { env, room: ROOM, params: paramsFor() })

    const row = await runRow()
    expect(row?.status).toBe('completed')
    expect(row?.manifest).toEqual([
      expect.objectContaining({ kind: 'agent', id: agentId, versionNumber: 1 }),
    ])
    expect((row?.manifest as object[])[0]).not.toHaveProperty('config')
    expect(prompts.join()).toContain('prompt v1')
  })

  test('a spawned run executes its inherited refs and stores no copy', async () => {
    const inherited = toManifestRefs(
      await resolveRunManifest(db, graphOf(agentId)),
    )
    await publishAgent(db, { agentId, config: agentConfig('prompt v2') })

    await runInlineGraph(config, {
      env,
      room: ROOM,
      params: paramsFor({ inheritedManifest: inherited }),
    })

    const row = await runRow()
    expect(row?.status).toBe('completed')
    expect(row?.manifest).toEqual([])
    expect(prompts.join()).toContain('prompt v1')
    expect(prompts.join()).not.toContain('prompt v2')
  })

  test('a resumed spawned run still has its refs, from params', async () => {
    const inherited = toManifestRefs(
      await resolveRunManifest(db, graphOf(agentId)),
    )
    await publishAgent(db, { agentId, config: agentConfig('prompt v2') })

    await runInlineGraph(config, {
      env,
      room: ROOM,
      params: paramsFor({
        inheritedManifest: inherited,
        resumeFromRunId: 'run-1',
      }),
      resume: { attempt: 1, reason: 'restart' },
    })

    expect((await runRow())?.status).toBe('completed')
    expect(prompts.join()).toContain('prompt v1')
  })

  test('a resume whose first attempt froze nothing resolves fresh', async () => {
    await runInlineGraph(config, {
      env,
      room: ROOM,
      params: paramsFor({ resumeFromRunId: 'run-1' }),
      resume: { attempt: 1, reason: 'restart' },
    })

    const row = await runRow()
    expect(row?.status).toBe('completed')
    expect(row?.manifest).toHaveLength(1)
  })

  test('a resume uses the versions the first attempt froze', async () => {
    // A first attempt that froze its manifest and died before finishing a node.
    await setRunManifest(db, {
      runId: 'run-1',
      manifest: await resolveRunManifest(db, graphOf(agentId)),
    })
    await publishAgent(db, { agentId, config: agentConfig('prompt v2') })

    await runInlineGraph(config, {
      env,
      room: ROOM,
      params: paramsFor({ resumeFromRunId: 'run-1' }),
      resume: { attempt: 1, reason: 'restart' },
    })

    expect(prompts.join()).toContain('prompt v1')
    expect(prompts.join()).not.toContain('prompt v2')
    expect((await runRow())?.manifest).toEqual([
      expect.objectContaining({ versionNumber: 1 }),
    ])
  })
})
