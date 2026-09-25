import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import { agentConfigSchema } from '../engine/graph'
import type { WorkflowGraph, WorkflowNode } from '../engine/graph'
import { createLocalWfDataClient } from '../server/handlers'
import type { CreateWfSdkHandlersOptions } from '../server/handlers/shared'
import type { WfDataClient } from '../server/protocol'
import type { WfDb } from '../storage/client'
import { createAgent } from '../storage/data'
import { wfSchema } from '../storage/schema'

import { allTools } from './catalog'
import type { WfMcpTool } from './tools'

// The workflow and agent lifecycle driven END TO END — real tool definitions,
// through the same `createLocalWfDataClient` dispatcher `/api/mcp` mounts,
// against a real migrated database.
//
// Two of these could only ever be caught here, because the thing that was wrong
// lived in the handler rather than in the tool:
//
//   • `get_agent` hard-coded `workflows: []`, so "which workflows run this
//     agent?" — asked at the natural place — answered "none" in exactly the
//     shape a true answer has. Every stub in the unit tests would have returned
//     whatever it was told to.
//   • `create_workflow` seeds a graph through `buildStarterGraph` and publishes
//     it as v1. What that graph actually LINTS as is a property of the storage
//     layer and the graph schema agreeing, not of the tool — and it caught the
//     tool's description overclaiming: a fresh workflow has one error, its
//     unbound Output, exactly as the console's New Workflow button produces.

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
})

beforeEach(async () => {
  db = freshDb()
  const created = await createAgent(db, {
    name: 'Conflict check',
    config: CONFIG,
  })
  // `createAgent` already seeds a PUBLISHED v1 — the same thing the console's
  // New Agent button does — so nothing else has to publish for the agent to be
  // runnable and referenceable.
  agentId = created.agentId

  const opts = {
    config: {
      listModels: async () => [
        { id: 'venice:test', label: 'Test', capabilities: { tools: true } },
      ],
      listProviders: async () => [{ id: 'venice', label: 'Venice' }],
      toolRegistry: new Map(),
      // No trigger events declared, so `create_workflow` can only be manual or
      // periodic here — which is itself worth exercising.
      triggers: {},
    },
    resolveDb: () => db,
    resolveContext: () => ({ userId: 'user_staff' }),
    onError: () => {},
  } as unknown as CreateWfSdkHandlersOptions<unknown>
  client = createLocalWfDataClient(opts, {
    ctx: { userId: 'user_staff' },
    req: new Request('http://localhost/api/mcp/write'),
  })
})

describe('building a workflow from nothing', () => {
  test('publishes v1 with the Output deliberately unbound, then grows', async () => {
    const made = (await tool('create_workflow').run(client, {
      name: 'Intake',
    })) as {
      workflowId: string
      publishedVersion: number | null
      nodes: { trigger: string; output: string }
    }
    // v1 exists immediately, so the workflow is real and addressable.
    expect(made.publishedVersion).toBe(1)
    expect(made.nodes.trigger).toBeTruthy()

    // And it has exactly ONE thing wrong with it: the Output is unbound, which
    // is what the console's New Workflow produces too — there is nothing to bind
    // it to yet. The tool says so rather than claiming a clean graph, because
    // publish_workflow refuses while it stands.
    const lint = (await tool('validate_workflow_graph').run(client, {
      workflowId: made.workflowId,
    })) as { errors: number; verdict: string }
    expect(lint.errors).toBe(1)
    expect(JSON.stringify(lint)).toContain('No value bound')
    expect(lint.verdict).toContain('Cannot be published')

    // Grow it: add an agent node, point it at the agent, wire it in.
    const patched = (await tool('patch_workflow_draft').run(client, {
      workflowId: made.workflowId,
      ops: [{ op: 'add_node', kind: 'agent', label: 'Check conflicts' }],
    })) as { applied: { nodeId: string }[] }
    const nodeId = patched.applied[0].nodeId

    await tool('patch_workflow_draft').run(client, {
      workflowId: made.workflowId,
      ops: [
        {
          op: 'merge_node_config',
          nodeId,
          config: { agentId, version: null, inputs: {} },
        },
        // A customer-visible progress note — a SIBLING of config, which
        // merge_node_config cannot reach.
        {
          op: 'set_inform_user',
          nodeId,
          informUser: { mode: 'static', note: 'Checking for conflicts…' },
        },
        { op: 'set_node_execution', nodeId, execution: { timeoutMs: 60_000 } },
        { op: 'add_edge', source: made.nodes.trigger, target: nodeId },
      ],
    })

    const detail = (await tool('get_workflow').run(client, {
      workflowId: made.workflowId,
    })) as { draft: { graph: WorkflowGraph } }
    const added = detail.draft.graph.nodes.find((n) => n.id === nodeId)!
    expect(added.informUser).toEqual({
      mode: 'static',
      note: 'Checking for conflicts…',
    })
    expect(added.execution).toEqual({ timeoutMs: 60_000 })
  })

  test('refuses an event trigger this host does not declare', async () => {
    const out = (await tool('create_workflow').run(client, {
      name: 'On upload',
      trigger: 'document_uploaded',
    })) as { error: string }
    expect(out.error).toContain('could never fire')
    // Nothing was created.
    expect((await tool('list_workflows').run(client, {})) as unknown[]).toEqual(
      [],
    )
  })

  test('archiving drops a workflow out of the list and restoring brings it back', async () => {
    const made = (await tool('create_workflow').run(client, {
      name: 'Retire me',
    })) as { workflowId: string }

    const out = (await tool('update_workflow').run(client, {
      workflowId: made.workflowId,
      archived: true,
    })) as { after: { archived: boolean } }
    expect(out.after.archived).toBe(true)
    expect((await tool('list_workflows').run(client, {})) as unknown[]).toEqual(
      [],
    )

    await tool('update_workflow').run(client, {
      workflowId: made.workflowId,
      archived: false,
    })
    expect(
      ((await tool('list_workflows').run(client, {})) as unknown[]).length,
    ).toBe(1)
  })
})

describe('an agent knows what depends on it', () => {
  // The handler bug: `workflows: []` was hard-coded, so the single-agent read —
  // the natural place to ask "what breaks if I change this?" — answered "nothing"
  // in the same shape a true answer has.
  test('get_agent names the workflows referencing it', async () => {
    const made = (await tool('create_workflow').run(client, {
      name: 'Intake',
    })) as { workflowId: string; nodes: { trigger: string } }
    const patched = (await tool('patch_workflow_draft').run(client, {
      workflowId: made.workflowId,
      ops: [{ op: 'add_node', kind: 'agent' }],
    })) as { applied: { nodeId: string }[] }
    await tool('patch_workflow_draft').run(client, {
      workflowId: made.workflowId,
      ops: [
        {
          op: 'merge_node_config',
          nodeId: patched.applied[0].nodeId,
          config: { agentId, version: null, inputs: {} },
        },
      ],
    })

    const detail = (await tool('get_agent').run(client, { agentId })) as {
      agent: { workflows: { id: string; name: string }[] }
    }
    expect(detail.agent.workflows.map((w) => w.name)).toEqual(['Intake'])
  })

  test('list_agent_versions reads back the exact published config', async () => {
    const out = (await tool('list_agent_versions').run(client, {
      agentId,
      versionNumber: 1,
    })) as { config: { prompt: string }; isLive: boolean }
    expect(out.config.prompt).toBe('You check for conflicts.')
    expect(out.isLive).toBe(true)
  })

  test('a draft edit is preflighted, restorable, and never published', async () => {
    // A bogus model is refused BEFORE it is written — this used to save cleanly
    // and fail on the first real run.
    const refused = (await tool('update_agent_draft').run(client, {
      agentId,
      config: { ...CONFIG, modelId: 'test' },
    })) as { error: string }
    expect(refused.error).toContain('composite')

    await tool('update_agent_draft').run(client, {
      agentId,
      config: { ...CONFIG, prompt: 'Be much terser.' },
    })
    const edited = (await tool('get_agent').run(client, { agentId })) as {
      draft: { config: { prompt: string } }
      currentVersion: { config: { prompt: string }; versionNumber: number }
    }
    expect(edited.draft.config.prompt).toBe('Be much terser.')
    // The published version is untouched — the whole point of the draft-only path.
    expect(edited.currentVersion.config.prompt).toBe('You check for conflicts.')

    const restored = (await tool('update_agent_draft').run(client, {
      agentId,
      fromVersion: 1,
    })) as { restoredFrom: number }
    expect(restored.restoredFrom).toBe(1)
    const back = (await tool('get_agent').run(client, { agentId })) as {
      draft: { config: { prompt: string } }
    }
    expect(back.draft.config.prompt).toBe('You check for conflicts.')
  })

  test('discard_agent_draft says what it threw away', async () => {
    await tool('update_agent_draft').run(client, {
      agentId,
      config: { ...CONFIG, prompt: 'A bad idea.' },
    })
    const out = (await tool('discard_agent_draft').run(client, {
      agentId,
    })) as { discarded: string[] }
    expect(out.discarded).toEqual(['prompt'])
  })

  test('a rename is cosmetic and lands in the change feed', async () => {
    await tool('update_agent').run(client, { agentId, name: 'Conflicts v2' })
    const detail = (await tool('get_agent').run(client, { agentId })) as {
      agent: { name: string; latestVersionNumber: number | null }
    }
    expect(detail.agent.name).toBe('Conflicts v2')
    // No version was created by a rename.
    expect(detail.agent.latestVersionNumber).toBe(1)

    const changes = (await tool('list_changes').run(client, {
      entityKind: 'agent',
    })) as { actorId: string | null }[]
    expect(changes.length).toBeGreaterThan(0)
    expect(changes.every((c) => c.actorId === 'user_staff')).toBe(true)
  })
})

describe('the tool catalog drill-in', () => {
  test('answers with argument schemas for a named tool, or says it is unknown', async () => {
    const out = (await tool('get_tool_catalog').run(client, {
      toolIds: ['mcp:linear:create_issue'],
    })) as { tools: unknown[]; missing: string[]; note: string }
    // Nothing is registered on this host, so this exercises the refusal path —
    // which is the one that has to name where an id can go missing.
    expect(out.tools).toEqual([])
    expect(out.missing).toEqual(['mcp:linear:create_issue'])
    expect(out.note).toContain('list_connectors')
  })
})

describe('graph ops reach an iteration subgraph, through the real schema', () => {
  // The unit tests assert this against a hand-built graph. This one proves the
  // shape survives `workflowGraphShapeSchema` and a round trip through storage —
  // an inner node that could be configured but not deleted was the half-
  // implemented state, and half-reachable reads as supported.
  test('a node added inside an iteration can be configured and then removed', async () => {
    const made = (await tool('create_workflow').run(client, {
      name: 'Per item',
    })) as { workflowId: string }
    const iter = (await tool('patch_workflow_draft').run(client, {
      workflowId: made.workflowId,
      ops: [{ op: 'add_node', kind: 'iteration' }],
    })) as { applied: { nodeId: string }[] }
    const iterId = iter.applied[0].nodeId

    const inner = (await tool('patch_workflow_draft').run(client, {
      workflowId: made.workflowId,
      ops: [{ op: 'add_node', kind: 'text', subgraphOf: iterId }],
    })) as { applied: { nodeId: string }[] }
    const innerId = inner.applied[0].nodeId

    const configured = (await tool('patch_workflow_draft').run(client, {
      workflowId: made.workflowId,
      ops: [
        { op: 'set_node_label', nodeId: innerId, label: 'Per-item text' },
      ],
    })) as { applied: unknown[] }
    expect(configured.applied).toHaveLength(1)

    const removed = (await tool('patch_workflow_draft').run(client, {
      workflowId: made.workflowId,
      ops: [{ op: 'remove_node', nodeId: innerId }],
    })) as { applied: { summary: string }[] }
    expect(removed.applied[0]?.summary).toContain('iteration subgraph')

    const detail = (await tool('get_workflow').run(client, {
      workflowId: made.workflowId,
    })) as { draft: { graph: WorkflowGraph } }
    const iteration = detail.draft.graph.nodes.find(
      (n) => n.id === iterId,
    ) as Extract<WorkflowNode, { kind: 'iteration' }>
    // Gone from the subgraph — which is seeded with its own trigger/output
    // bookends, so the assertion is about the node that was added, not an
    // empty list.
    expect(iteration.config.subgraph.nodes.map((n) => n.id)).not.toContain(
      innerId,
    )
    expect(
      iteration.config.subgraph.nodes.every((n) => n.kind !== 'text'),
    ).toBe(true)
  })
})
