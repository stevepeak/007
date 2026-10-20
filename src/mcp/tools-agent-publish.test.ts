import { describe, expect, test } from 'bun:test'

import { makeAgentConfig } from '../engine/agent-test-helpers'
import type { WorkflowGraph } from '../engine/graph'
import type {
  WfAgentDetail,
  WfAgentSummary,
  WfDataClient,
  WfWorkflowDetail,
} from '../server/protocol'

import { agentPublishTools } from './tools-agent-publish'

// `publish_agent` is the one MCP write whose blast radius the arguments cannot
// show, so what these pin is the gating: nothing publishes without a dry run,
// the dry run names who is affected, and the confirmation is bound to the
// draft it reviewed.

const tool = agentPublishTools()[0]

const live = makeAgentConfig({ prompt: 'Be brief.' })
const draft = makeAgentConfig({ prompt: 'Be brief and cite sources.' })

function agentDetail(over: Partial<WfAgentDetail> = {}): WfAgentDetail {
  return {
    agent: { id: 'a1', name: 'Intake', kind: 'generation' } as WfAgentDetail['agent'],
    draft: { config: draft },
    currentVersion: { id: 'v3', versionNumber: 3, config: live },
    ...over,
  }
}

/** A graph whose agent node points at `a1`, optionally pinned. */
function graphWith(version: number | null, nested = false): WorkflowGraph {
  const agentNode = {
    id: 'n1',
    kind: 'agent',
    label: 'Draft reply',
    position: { x: 0, y: 0 },
    informUser: { mode: 'off' },
    config: { agentId: 'a1', version, inputs: {} },
  }
  const node = nested
    ? {
        id: 'it',
        kind: 'iteration',
        label: 'Each item',
        position: { x: 0, y: 0 },
        informUser: { mode: 'off' },
        config: { subgraph: { version: 1, nodes: [agentNode], edges: [] } },
      }
    : agentNode
  return { version: 1, nodes: [node], edges: [] } as unknown as WorkflowGraph
}

function workflow(graph: WorkflowGraph | null): WfWorkflowDetail {
  return {
    currentVersion: graph ? { graph } : null,
    draft: null,
  } as unknown as WfWorkflowDetail
}

type Calls = { published: unknown[] }

function client(
  over: Partial<WfDataClient> = {},
  calls: Calls = { published: [] },
): WfDataClient {
  const workflows: Record<string, WfWorkflowDetail> = {
    w_float: workflow(graphWith(null)),
    w_nested: workflow(graphWith(null, true)),
    w_pinned: workflow(graphWith(2)),
    w_draft: workflow(null),
  }
  return {
    getAgent: async () => agentDetail(),
    listModels: async () => [
      { id: 'test-model', label: 'Test', capabilities: {} },
    ],
    listTools: async () => [],
    listAgents: async () => [
      {
        id: 'a1',
        workflows: Object.keys(workflows).map((id) => ({ id, name: id })),
      } as unknown as WfAgentSummary,
    ],
    getWorkflow: async (id: string) => workflows[id] ?? null,
    summarizeAgentChanges: async () => ({ short: 'cites sources', long: '' }),
    publishAgent: async (input) => {
      calls.published.push(input)
      return { versionId: 'v4', versionNumber: 4 }
    },
    ...over,
  } as WfDataClient
}

async function dryRun(c: WfDataClient = client()) {
  return (await tool.run(c, { agentId: 'a1', baseVersionNumber: 3 })) as {
    dryRun: boolean
    confirm: string
    changed: string[]
    affected: {
      floating: { workflowId: string; nodes: string[] }[]
      pinned: { workflowId: string; pinnedVersions: number[] }[]
      draftOnly: { workflowId: string }[]
    }
  }
}

describe('publish_agent — the dry run', () => {
  test('publishes nothing and names the blast radius', async () => {
    const calls: Calls = { published: [] }
    const out = await dryRun(client({}, calls))
    expect(calls.published).toEqual([])
    expect(out.dryRun).toBe(true)
    expect(out.changed).toEqual(['prompt'])
    expect(out.confirm).toMatch(/^[0-9a-f]{12}$/)
    expect(out.affected.floating.map((w) => w.workflowId).sort()).toEqual([
      'w_float',
      'w_nested',
    ])
    expect(
      out.affected.pinned.map((w) => [w.workflowId, w.pinnedVersions]),
    ).toEqual([['w_pinned', [2]]])
    expect(out.affected.draftOnly.map((w) => w.workflowId)).toEqual(['w_draft'])
  })

  test('the token is stable for the same draft', async () => {
    expect((await dryRun()).confirm).toBe((await dryRun()).confirm)
  })
})

describe('publish_agent — publishing', () => {
  test('publishes the reviewed draft with its note and summary', async () => {
    const calls: Calls = { published: [] }
    const c = client({}, calls)
    const { confirm } = await dryRun(c)
    const out = (await tool.run(c, {
      agentId: 'a1',
      baseVersionNumber: 3,
      confirm,
      changeNote: 'Cite sources',
    })) as { ok: boolean; published: { versionNumber: number } }
    expect(out.ok).toBe(true)
    expect(out.published.versionNumber).toBe(4)
    expect(calls.published).toEqual([
      {
        agentId: 'a1',
        config: draft,
        changeNote: 'Cite sources',
        aiSummary: { short: 'cites sources', long: '' },
        baseVersionNumber: 3,
      },
    ])
  })

  test('a draft edited after the dry run is refused', async () => {
    const calls: Calls = { published: [] }
    const { confirm } = await dryRun()
    const edited = makeAgentConfig({ prompt: 'Something else entirely.' })
    const c = client(
      { getAgent: async () => agentDetail({ draft: { config: edited } }) },
      calls,
    )
    const out = (await tool.run(c, {
      agentId: 'a1',
      baseVersionNumber: 3,
      confirm,
      changeNote: 'x',
    })) as { error: string }
    expect(out.error).toContain('does not match this draft')
    expect(calls.published).toEqual([])
  })

  test('changeNote is required to publish', async () => {
    const c = client()
    const { confirm } = await dryRun(c)
    const out = (await tool.run(c, {
      agentId: 'a1',
      baseVersionNumber: 3,
      confirm,
    })) as { error: string }
    expect(out.error).toContain('changeNote')
  })
})

describe('publish_agent — refusals before anything else', () => {
  test('a stale base version', async () => {
    const out = (await tool.run(client(), {
      agentId: 'a1',
      baseVersionNumber: 2,
    })) as { error: string }
    expect(out.error).toContain('v3 is live')
  })

  test('no draft, or a draft identical to live', async () => {
    const none = (await tool.run(
      client({ getAgent: async () => agentDetail({ draft: null }) }),
      { agentId: 'a1', baseVersionNumber: 3 },
    )) as { error: string }
    expect(none.error).toContain('no draft')

    const same = (await tool.run(
      client({
        getAgent: async () => agentDetail({ draft: { config: live } }),
      }),
      { agentId: 'a1', baseVersionNumber: 3 },
    )) as { error: string }
    expect(same.error).toContain('identical')
  })

  test('a draft that would not run', async () => {
    const out = (await tool.run(client({ listModels: async () => [] }), {
      agentId: 'a1',
      baseVersionNumber: 3,
    })) as { error: string }
    expect(out.error).toContain('would not run')
  })
})
