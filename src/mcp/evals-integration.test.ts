import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import { agentConfigSchema } from '../engine/graph'
import { createLocalWfDataClient } from '../server/handlers'
import type { CreateWfSdkHandlersOptions } from '../server/handlers/shared'
import type { WfDataClient } from '../server/protocol'
import type { WfDb } from '../storage/client'
import { createAgent, publishAgent } from '../storage/data'
import { wfSchema } from '../storage/schema'

import { allTools } from './catalog'
import type { WfMcpTool } from './tools'

// The eval tools driven END TO END: the real MCP tool definition, through the
// real `createLocalWfDataClient` dispatcher (the same one `/api/mcp` mounts,
// with the same wire-schema validation and the same `wf_change` writes), against
// a real migrated database.
//
// The unit tests beside these stub `WfDataClient`, which is the right shape for
// asserting what a tool DOES with an answer — and structurally unable to catch
// the thing that actually went wrong here. `upsert_eval_sample`'s destructive
// overwrite lived entirely in the gap between the tool and the storage layer:
// every stub returned a plausible `{ rowId }`, and the data loss happened in a
// SQL UPDATE nobody was watching. So these tests read the row back.

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../migrations', import.meta.url),
)

function freshDb(): WfDb {
  const sqlite = new Database(':memory:')
  for (const f of readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    for (const stmt of readFileSync(`${MIGRATIONS_DIR}/${f}`, 'utf8').split(
      '--> statement-breakpoint',
    )) {
      const trimmed = stmt.trim()
      if (trimmed) sqlite.run(trimmed)
    }
  }
  return drizzle(sqlite, { schema: wfSchema }) as unknown as WfDb
}

function tool(name: string): WfMcpTool {
  const found = allTools().find((t) => t.name === name)
  if (!found) throw new Error(`no such tool: ${name}`)
  return found
}

let db: WfDb
let client: WfDataClient
let agentId: string

const CONFIG = agentConfigSchema.parse({
  modelId: 'venice:test',
  prompt: 'You check for conflicts.',
  userPrompt: 'Check ${matterName}.',
  inputKind: 'task',
  toolIds: ['search_rag'],
  output: {
    kind: 'object',
    schema: {
      type: 'object',
      properties: {
        verdict: { type: 'string' },
        rationale: { type: 'string' },
      },
    },
  },
})

beforeEach(async () => {
  db = freshDb()
  const created = await createAgent(db, {
    name: 'Conflict check',
    config: CONFIG,
  })
  agentId = created.agentId
  // Published, so the Goal's target resolves to a config the lints can read —
  // an unpublished agent deliberately reports "unknown tools" rather than none.
  await publishAgent(db, { agentId, config: CONFIG })

  const opts = {
    config: { listModels: async () => [], toolRegistry: new Map() },
    resolveDb: () => db,
    resolveContext: () => ({ userId: 'user_staff' }),
    onError: () => {},
  } as unknown as CreateWfSdkHandlersOptions<unknown>
  client = createLocalWfDataClient(opts, {
    ctx: { userId: 'user_staff' },
    req: new Request('http://localhost/api/mcp/write'),
  })
})

async function seedGoalWithSample(): Promise<{
  setId: string
  rowId: string
}> {
  const goal = (await tool('create_eval_set').run(client, {
    name: 'Refusal cases',
    targetId: agentId,
  })) as { setId: string }
  const sample = (await tool('upsert_eval_sample').run(client, {
    setId: goal.setId,
    name: 'Refuses out of scope',
    input: { kind: 'task', variables: { matterName: 'Acme v. Byrne' } },
    tools: { mode: 'mocked', fixtures: { search_rag: { hits: [] } } },
    checks: {
      op: 'and',
      checks: [
        { type: 'tool_called', toolId: 'search_rag', called: true },
        { type: 'decision_judge', rubric: 'Does it refuse?', threshold: 0.7 },
      ],
    },
  })) as { rowId: string }
  return { setId: goal.setId, rowId: sample.rowId }
}

describe('authoring a Goal over the real dispatcher', () => {
  test('a Sample survives a rename with its checks intact', async () => {
    const { setId, rowId } = await seedGoalWithSample()

    // The call that used to delete every check on the row.
    const edit = (await tool('upsert_eval_sample').run(client, {
      setId,
      id: rowId,
      name: 'Refuses politely',
    })) as { replaced: string[]; created: boolean }
    expect(edit.created).toBe(false)
    expect(edit.replaced).toEqual([])

    const after = (await tool('get_eval_set').run(client, { setId })) as {
      rows: {
        name: string
        checks: { checks: { type: string }[] }
        tools: { fixtures: Record<string, unknown> }
      }[]
    }
    expect(after.rows[0]?.name).toBe('Refuses politely')
    expect(after.rows[0]?.checks.checks.map((c) => c.type)).toEqual([
      'tool_called',
      'decision_judge',
    ])
    expect(Object.keys(after.rows[0]?.tools.fixtures ?? {})).toEqual([
      'search_rag',
    ])
  })

  // The check type that could not be authored over MCP at all, because the
  // tool's description hardcoded six types and left this one out.
  test('a decision_judge round-trips with its threshold', async () => {
    const { setId } = await seedGoalWithSample()
    const after = (await tool('get_eval_set').run(client, { setId })) as {
      rows: { checks: { checks: Record<string, unknown>[] } }[]
    }
    const judge = after.rows[0]?.checks.checks.find(
      (c) => c.type === 'decision_judge',
    )
    expect(judge?.rubric).toBe('Does it refuse?')
    expect(judge?.threshold).toBe(0.7)
  })

  test('the target contract carries the tools and output schema to author against', async () => {
    const { setId } = await seedGoalWithSample()
    const out = (await tool('get_eval_set').run(client, { setId })) as {
      target: { toolIds: string[]; outputSchema: { properties: object } }
    }
    expect(out.target.toolIds).toEqual(['search_rag'])
    expect(Object.keys(out.target.outputSchema.properties)).toEqual([
      'verdict',
      'rationale',
    ])
  })

  test('a fixture on a tool the agent lacks is reported, not silently stored dead', async () => {
    const { setId } = await seedGoalWithSample()
    const out = (await tool('upsert_eval_sample').run(client, {
      setId,
      name: 'Mocks a tool that is not wired',
      input: { kind: 'task', variables: { matterName: 'x' } },
      tools: { mode: 'mocked', fixtures: { list_matters: {} } },
      checks: {
        op: 'and',
        checks: [{ type: 'output_match', path: 'verdict', match: 'equals', value: 'no' }],
      },
    })) as { warnings: string[] }
    expect(out.warnings.join(' ')).toContain('list_matters')
  })
})

describe('a Goal and its Samples are retirable and restorable', () => {
  test('archive then restore a Sample, through get_eval_set both ways', async () => {
    const { setId, rowId } = await seedGoalWithSample()

    await tool('delete_eval_sample').run(client, { rowId })
    const gone = (await tool('get_eval_set').run(client, { setId })) as {
      set: { rowCount: number }
      rows: unknown[]
    }
    expect(gone.rows).toHaveLength(0)
    expect(gone.set.rowCount).toBe(0)

    const withArchived = (await tool('get_eval_set').run(client, {
      setId,
      includeArchived: true,
    })) as { set: { rowCount: number }; rows: { archived: boolean }[] }
    expect(withArchived.rows).toHaveLength(1)
    expect(withArchived.rows[0]?.archived).toBe(true)
    // The count stays over LIVE rows, so a Goal's advertised size doesn't
    // change depending on who asked.
    expect(withArchived.set.rowCount).toBe(0)

    await tool('delete_eval_sample').run(client, { rowId, restore: true })
    const back = (await tool('get_eval_set').run(client, { setId })) as {
      rows: { checks: { checks: unknown[] } }[]
    }
    expect(back.rows).toHaveLength(1)
    // Restoring gets the test back, not an empty shell.
    expect(back.rows[0]?.checks.checks).toHaveLength(2)
  })

  test('update_eval_set pins, unpins and archives a Goal', async () => {
    const { setId } = await seedGoalWithSample()

    const pinned = (await tool('update_eval_set').run(client, {
      setId,
      name: 'Refusal cases (v1 baseline)',
      targetVersion: 1,
    })) as { after: { name: string; targetVersion: number | null } }
    expect(pinned.after.name).toBe('Refusal cases (v1 baseline)')
    expect(pinned.after.targetVersion).toBe(1)

    const floated = (await tool('update_eval_set').run(client, {
      setId,
      floatTargetVersion: true,
    })) as { after: { targetVersion: number | null } }
    // Back to grading whatever actually ships.
    expect(floated.after.targetVersion).toBeNull()

    await tool('update_eval_set').run(client, { setId, archived: true })
    const live = (await tool('list_eval_sets').run(client, {})) as unknown[]
    expect(live).toHaveLength(0)
    const all = (await tool('list_eval_sets').run(client, {
      includeArchived: true,
    })) as unknown[]
    expect(all).toHaveLength(1)

    // And back — an MCP session that creates a bad Goal can now clean up.
    await tool('update_eval_set').run(client, { setId, archived: false })
    expect((await tool('list_eval_sets').run(client, {})) as unknown[]).toHaveLength(1)
  })

  // Every edit above is attributed to the person who authorized the session,
  // which is the only who-touched-this record 007 keeps.
  test('the edits land in the change feed under the acting user', async () => {
    const { setId } = await seedGoalWithSample()
    await tool('update_eval_set').run(client, { setId, name: 'Renamed' })
    const changes = (await tool('list_changes').run(client, {
      entityKind: 'eval_set',
    })) as { actorId: string | null; action: string }[]
    expect(changes.length).toBeGreaterThan(0)
    expect(changes.every((c) => c.actorId === 'user_staff')).toBe(true)
    expect(changes.map((c) => c.action)).toContain('create')
  })
})

describe('a sweep can be called off', () => {
  test('cancel_eval_run stops a live run and refuses a finished one', async () => {
    const { setId } = await seedGoalWithSample()
    const { evalRunId } = await client.createEvalRun({
      setIds: [setId],
      total: 40,
    })

    const stopped = (await tool('cancel_eval_run').run(client, {
      evalRunId,
    })) as { cancelled: boolean; status: string; total: number; note: string }
    expect(stopped.cancelled).toBe(true)
    expect(stopped.status).toBe('cancelled')
    // 40 cells requested, none settled — the gap is what was called off.
    expect(stopped.total).toBe(40)

    const again = (await tool('cancel_eval_run').run(client, {
      evalRunId,
    })) as { cancelled: boolean; note: string }
    expect(again.cancelled).toBe(false)
    expect(again.note).toContain('already')
  })
})
