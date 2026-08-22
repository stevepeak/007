import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import type { AgentConfig } from '../../engine/graph'
import type { WfDb } from '../../storage/client'
import { createAgent, listAgentVersions } from '../../storage/data'
import { wfSchema } from '../../storage/schema'

import { buildAgentHandlers } from './agents'
import type { CreateWfSdkHandlersOptions, HandlerCtx } from './shared'

// The publish path end-to-end through the handler: the AI summary riding along
// with the publish, the background fill when it didn't, and the restore read.
// Everything below the handler is real (a migrated in-memory D1); only the model
// seam and the host's scheduler are stubbed.

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

function config(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    modelId: 'test-model',
    prompt: 'You are a costing assistant.',
    userPrompt: 'Cost this dish: ${dish}',
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

// Deferred work the host would hand to `ctx.waitUntil`, collected so the test
// can await it deterministically instead of racing it.
let pending: Promise<unknown>[] = []

function options(
  over: Partial<CreateWfSdkHandlersOptions<unknown>> = {},
): CreateWfSdkHandlersOptions<unknown> {
  return {
    config: {
      // No model on offer → computeAgentChangeSummary falls to the heuristic,
      // which is what keeps this test free of any network call.
      listModels: async () => [],
    },
    resolveDb: () => {
      throw new Error('unused')
    },
    resolveContext: () => ({}),
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p)
    },
    ...over,
  } as unknown as CreateWfSdkHandlersOptions<unknown>
}

function ctx(db: WfDb, params: unknown): HandlerCtx {
  return {
    params,
    ctx: { userId: 'tester' },
    db,
    req: new Request('http://localhost/api/wf', { method: 'POST' }),
    env: async () => ({}),
    analytics: async () => null,
  }
}

describe('agent publish handler', () => {
  let db: WfDb
  let agentId: string

  beforeEach(async () => {
    pending = []
    db = freshDb()
    const created = await createAgent(db, { name: 'Coster', config: config() })
    agentId = created.agentId
  })

  test("a summary supplied by the dialog is stored and no background work is queued", async () => {
    const handlers = buildAgentHandlers(options())
    await handlers.publishAgent(
      ctx(db, {
        agentId,
        config: config({ maxTurns: 9 }),
        changeNote: 'more turns',
        aiSummary: { short: 'Raise the turn limit', long: '- 5 → 9' },
      }),
    )

    expect(pending).toHaveLength(0)
    const [latest] = await listAgentVersions(db, agentId)
    expect(latest.versionNumber).toBe(2)
    expect(latest.changeNote).toBe('more turns')
    expect(latest.aiSummaryShort).toBe('Raise the turn limit')
    expect(latest.aiSummaryLong).toBe('- 5 → 9')
  })

  test('publishing without a summary fills it in the background', async () => {
    const handlers = buildAgentHandlers(options())
    await handlers.publishAgent(
      ctx(db, { agentId, config: config({ modelId: 'other-model' }) }),
    )

    // Before the deferred work runs, the row is published but unsummarized —
    // this is the state the UI polls on.
    const [beforeFill] = await listAgentVersions(db, agentId)
    expect(beforeFill.versionNumber).toBe(2)
    expect(beforeFill.aiSummaryShort).toBeNull()

    expect(pending).toHaveLength(1)
    await Promise.all(pending)

    const [afterFill] = await listAgentVersions(db, agentId)
    // The diff is against v1, captured before the publish moved the head.
    expect(afterFill.aiSummaryShort).toBe('Changed the model.')
  })

  test('no scheduler wired means no background fill, and the publish still succeeds', async () => {
    const handlers = buildAgentHandlers(options({ waitUntil: undefined }))
    const out = await handlers.publishAgent(
      ctx(db, { agentId, config: config({ maxTurns: 3 }) }),
    )

    expect((out as { versionNumber: number }).versionNumber).toBe(2)
    expect(pending).toHaveLength(0)
    expect((await listAgentVersions(db, agentId))[0].aiSummaryShort).toBeNull()
  })

  test('a host override wins over the built-in summarizer', async () => {
    const handlers = buildAgentHandlers(
      options({
        summarizeAgentChanges: async () => ({
          short: 'From the host',
          long: '',
        }),
      }),
    )
    const summary = await handlers.summarizeAgentChanges(
      ctx(db, { agentId, config: config({ maxTurns: 7 }) }),
    )
    expect(summary).toEqual({ short: 'From the host', long: '' })
  })

  test('summarizeAgentChanges diffs against the published head without publishing', async () => {
    const handlers = buildAgentHandlers(options())
    const summary = await handlers.summarizeAgentChanges(
      ctx(db, { agentId, config: config({ toolIds: ['search_catalog'] }) }),
    )
    expect(summary).toEqual({ short: 'Added 1 tool.', long: '' })
    // Still just the seeded version — summarizing is not publishing.
    expect(await listAgentVersions(db, agentId)).toHaveLength(1)
  })

  test('getAgentVersion returns a historical config, and null for an unknown id', async () => {
    const handlers = buildAgentHandlers(options())
    const [v1] = await listAgentVersions(db, agentId)
    await handlers.publishAgent(
      ctx(db, { agentId, config: config({ prompt: 'Totally different.' }) }),
    )

    const restored = (await handlers.getAgentVersion(
      ctx(db, { versionId: v1.id }),
    )) as { config: AgentConfig; versionNumber: number }
    expect(restored.versionNumber).toBe(1)
    expect(restored.config.prompt).toBe('You are a costing assistant.')

    expect(await handlers.getAgentVersion(ctx(db, { versionId: 'nope' }))).toBeNull()
  })
})
