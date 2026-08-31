import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import type { AgentConfig } from '../../engine/graph'
import type { WfDb } from '../../storage/client'
import { createAgent } from '../../storage/data'
import { wfSchema } from '../../storage/schema'
import { createWfSdkHandlers } from '../handlers'
import {
  BadRequestError,
  UnauthorizedError,
  type CreateWfSdkHandlersOptions,
} from '../handlers/shared'
import { createLocalWfDataClient } from '../local-client'

import { createCopilotTools } from './tools'

// The copilot's tools now run through the mounted data route rather than
// straight at storage. That is the whole change, and these pin what it buys:
// the host's auth gate runs on every tool call, and a handler's error reaches
// the model as something it can read instead of stalling the loop.

function options(
  over: Partial<CreateWfSdkHandlersOptions<unknown>>,
): CreateWfSdkHandlersOptions<unknown> {
  return {
    config: { listModels: async () => [], toolRegistry: new Map() },
    resolveDb: () => {
      throw new BadRequestError('reached the handler')
    },
    resolveContext: () => ({ userId: 'user_123' }),
    onError: () => {},
    ...over,
  } as unknown as CreateWfSdkHandlersOptions<unknown>
}

function callList(opts: CreateWfSdkHandlersOptions<unknown>): Promise<unknown> {
  const client = createLocalWfDataClient({
    handler: createWfSdkHandlers(opts),
    request: new Request('http://localhost/api/copilot', {
      method: 'POST',
      headers: { cookie: 'session=abc' },
      body: '{}',
    }),
  })
  return call(createCopilotTools(client), 'list_agents', {})
}

function call(
  tools: ReturnType<typeof createCopilotTools>,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const run = tools[name]?.execute
  if (!run) throw new Error(`${name} is not registered`)
  return Promise.resolve(
    run(args, { toolCallId: 't', messages: [], context: undefined }),
  )
}

describe('the copilot reaches its data through the mounted route', () => {
  test('a tool call is gated by the host, per call', async () => {
    expect(
      await callList(
        options({
          resolveContext: () => {
            throw new UnauthorizedError('Not authorized to use the copilot')
          },
        }),
      ),
    ).toEqual({ error: 'Not authorized to use the copilot' })
  })

  test("a handler's failure comes back as something the model can say", async () => {
    expect(await callList(options({}))).toEqual({
      error: 'reached the handler',
    })
  })
})

// The whole stack, with only the model seam absent: a migrated in-memory D1
// under the real dispatcher, reached by a copilot tool. What it proves is the
// thing a unit test of the adapter can't — that the tools still ANSWER after
// being re-pointed off storage and onto the mounted route.

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

function agentConfig(): AgentConfig {
  return {
    modelId: 'test-model',
    prompt: 'You are a costing assistant.',
    userPrompt: 'Cost this dish: ${dish}',
    toolIds: [],
    maxTurns: 5,
    toolTokenBudget: null,
    answerReservePercent: 20,
    requireToolFirstTurn: false,
    reasoning: true,
    inputKind: 'task',
    output: { kind: 'text' },
    subAgents: {
      targets: [],
      maxConcurrent: 4,
      maxSpawns: 10,
      allowStopSignal: true,
    },
  }
}

function clientOver(db: WfDb): ReturnType<typeof createLocalWfDataClient> {
  return createLocalWfDataClient({
    handler: createWfSdkHandlers(options({ resolveDb: () => db })),
    request: new Request('http://localhost/api/copilot', {
      method: 'POST',
      body: '{}',
    }),
  })
}

describe('end to end against a real database', () => {
  test('reads what the editor would read', async () => {
    const db = freshDb()
    const created = await createAgent(db, {
      name: 'Coster',
      config: agentConfig(),
    })
    const tools = createCopilotTools(clientOver(db))

    const listed = (await call(tools, 'list_agents', {})) as { name: string }[]
    expect(listed.map((a) => a.name)).toContain('Coster')

    const detail = (await call(tools, 'get_agent', {
      agentId: created.agentId,
    })) as { draft?: { config: { prompt: string } } }
    expect(detail.draft?.config.prompt).toBe('You are a costing assistant.')
  })

  test('a missing id is an answer, not a crash', async () => {
    const tools = createCopilotTools(clientOver(freshDb()))
    expect(await call(tools, 'get_agent', { agentId: 'nope' })).toEqual({
      error: 'No agent found for id nope.',
    })
  })
})
