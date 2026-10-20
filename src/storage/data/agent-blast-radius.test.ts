import { describe, expect, test } from 'bun:test'

import { makeAgentConfig } from '../../engine/agent-test-helpers'
import type { WorkflowGraph } from '../../engine/graph'
import { freshDb } from '../db-test-helpers'

import { createAgent } from './authoring-agents'
import { createWorkflow, updateDraft } from './authoring-workflows'
import { listAgentBlastRadius } from './authoring-workflows-references'

/** A graph whose agent node points at `agentId`, optionally pinned or nested. */
function graphWith(args: {
  agentId: string
  version: number | null
  nested?: boolean
}): WorkflowGraph {
  const agentNode = {
    id: 'n1',
    kind: 'agent',
    label: 'Draft reply',
    position: { x: 0, y: 0 },
    informUser: { mode: 'off' },
    config: { agentId: args.agentId, version: args.version, inputs: {} },
  }
  const node = args.nested
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

const empty = { version: 1, nodes: [], edges: [] } as unknown as WorkflowGraph

describe('listAgentBlastRadius', () => {
  test('sorts referencing workflows into floating, pinned and draft-only', async () => {
    const db = freshDb()
    const { agentId } = await createAgent(db, {
      name: 'Intake',
      config: makeAgentConfig(),
    })
    const add = async (name: string, graph: WorkflowGraph) => {
      return (await createWorkflow(db, { name, createdBy: 't', graph }))
        .workflowId
    }
    const float = await add('float', graphWith({ agentId, version: null }))
    const nested = await add(
      'nested',
      graphWith({ agentId, version: null, nested: true }),
    )
    const pinned = await add('pinned', graphWith({ agentId, version: 2 }))
    const draftOnly = await add('draft', empty)
    await updateDraft(db, {
      workflowId: draftOnly,
      graph: graphWith({ agentId, version: null }),
    })
    await add('unrelated', empty)

    const out = await listAgentBlastRadius(db, { agentId })
    expect(out.floating.map((w) => w.workflowId).sort()).toEqual(
      [float, nested].sort(),
    )
    expect(out.floating[0].nodes).toEqual(['Draft reply'])
    expect(out.pinned.map((w) => [w.workflowId, w.pinnedVersions])).toEqual([
      [pinned, [2]],
    ])
    expect(out.draftOnly.map((w) => w.workflowId)).toEqual([draftOnly])
  })
})
