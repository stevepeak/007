import { describe, expect, test } from 'bun:test'

import { createCopilotTools } from '../server/copilot/tools'
import type { WfDataClient } from '../server/protocol'

import { allTools, selectTools } from './catalog'
import { createWfToolSet } from './tool-set'
import type { WfMcpTool } from './tools'

/**
 * The point of this adapter is that there is ONE list. So what is worth testing
 * is the sameness — that the copilot's tools are the catalog's read tools, with
 * the catalog's own descriptions — rather than the mechanics of building a
 * `ToolSet`.
 */

function stubClient(partial: Partial<WfDataClient>): WfDataClient {
  return partial as WfDataClient
}

/** The AI SDK's `Tool` type keeps `execute` optional; every tool here has one. */
function execute(
  set: ReturnType<typeof createWfToolSet>,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const run = set[name]?.execute
  if (!run) throw new Error(`no such tool: ${name}`)
  return Promise.resolve(
    run(args, { toolCallId: 't', messages: [], context: undefined }),
  )
}

describe('the copilot and wf-mcp expose one list', () => {
  const copilot = createCopilotTools(stubClient({}))

  test('the copilot gets exactly the catalog read tools', () => {
    expect(Object.keys(copilot).sort()).toEqual(
      selectTools(allTools(), false)
        .map((t) => t.name)
        .sort(),
    )
  })

  // The acceptance criterion, stated as a test: a tool description is prompt,
  // so an edit to one has to reach both surfaces or they diverge in behavior.
  test('descriptions come from the definition, not a copy', () => {
    for (const t of selectTools(allTools(), false)) {
      expect(copilot[t.name]?.description).toBe(t.description)
    }
  })

  // Read-only by construction, not by a shorter list — see `copilot/tools.ts`.
  test('the copilot has no write tool at all', () => {
    const writes = allTools()
      .filter((t) => !t.readOnly)
      .map((t) => t.name)
    expect(writes.length).toBeGreaterThan(0)
    for (const name of writes) expect(copilot[name]).toBeUndefined()
  })
})

describe('createWfToolSet', () => {
  const defs: WfMcpTool[] = [
    {
      name: 'echo',
      title: 'Echo',
      description: 'echoes',
      inputSchema: {},
      readOnly: true,
      run: async (_client, args) => await Promise.resolve({ got: args }),
    },
  ]

  test('passes the model arguments through to the definition', async () => {
    const set = createWfToolSet(stubClient({}), defs)
    expect(await execute(set, 'echo', { a: 1 })).toEqual({ got: { a: 1 } })
  })

  test('binds the client the caller supplied', async () => {
    const client = stubClient({ listAgents: async () => await Promise.resolve([]) })
    let seen: unknown
    const set = createWfToolSet(client, [
      {
        ...defs[0],
        run: async (c) => {
          seen = c
          return await Promise.resolve(null)
        },
      },
    ])
    await execute(set, 'echo', {})
    expect(seen).toBe(client)
  })

  // An agent loop that gets a thrown tool error can only stall on it. The
  // reason — almost always auth or connectivity — is something it can say.
  test('answers a failure as a result the model can read', async () => {
    const set = createWfToolSet(stubClient({}), [
      {
        ...defs[0],
        run: () => {
          throw new Error('Unauthorized')
        },
      },
    ])
    expect(await execute(set, 'echo', {})).toEqual({ error: 'Unauthorized' })
  })
})
