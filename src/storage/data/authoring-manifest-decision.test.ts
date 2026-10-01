import { beforeEach, describe, expect, test } from 'bun:test'

import { makeAgentConfig } from '../../engine/agent-test-helpers'
import { starterDecisionAgentConfig } from '../../engine/decision-agent-schema'
import type { WorkflowGraph } from '../../engine/graph'
import type { WfDb } from '../client'
import { freshDb } from '../db-test-helpers'

import { createAgent } from './authoring-agents'
import { resolveRunManifest } from './authoring-manifest'

// Manifest resolution for decision agents. An agent node points at either kind
// of agent, and the manifest is where the kind is settled: a decision agent
// freezes into its own entry (a question set, not a prompt), parsed against its
// own schema — because manifest resolution runs BEFORE `markRunRunning`, a
// generation-shaped parse of it would surface as a run stuck at `queued` with no
// error and no logs.

function graph(nodes: WorkflowGraph['nodes']): WorkflowGraph {
  return { version: 1, nodes, edges: [] }
}

function agentNode(
  agentId: string,
  version: number | null = null,
): WorkflowGraph['nodes'][number] {
  return {
    id: 'write',
    kind: 'agent',
    label: 'Write',
    position: { x: 0, y: 0 },
    informUser: { mode: 'off' },
    config: { agentId, version, inputs: {} },
  }
}

describe('resolveRunManifest — decision agents', () => {
  let db: WfDb
  beforeEach(() => {
    db = freshDb()
  })

  const newDecisionAgent = async () => {
    const { agentId } = await createAgent(db, {
      name: 'Triage',
      kind: 'decision',
      config: starterDecisionAgentConfig('venice:jev-latest'),
    })
    return agentId
  }

  const newGenerationAgent = async () => {
    const { agentId } = await createAgent(db, {
      name: 'Writer',
      config: makeAgentConfig({ modelId: 'venice:m', prompt: 'Hi.' }),
    })
    return agentId
  }

  test('a decision agent behind an agent node is frozen with its version', async () => {
    const agentId = await newDecisionAgent()
    const manifest = await resolveRunManifest(db, graph([agentNode(agentId)]))
    expect(manifest).toHaveLength(1)
    expect(manifest[0]?.kind).toBe('decision-agent')
    expect(manifest[0]).toMatchObject({
      id: agentId,
      name: 'Triage',
      versionNumber: 1,
      pinnedVersion: null,
    })
  })

  test('the frozen entry carries the question set, so a run needs no live rows', async () => {
    const agentId = await newDecisionAgent()
    const [entry] = await resolveRunManifest(db, graph([agentNode(agentId)]))
    expect(
      entry?.kind === 'decision-agent' ? entry.config.questions.length : 0,
    ).toBe(1)
  })

  test('a version pin freezes that version', async () => {
    const agentId = await newDecisionAgent()
    const [entry] = await resolveRunManifest(db, graph([agentNode(agentId, 1)]))
    expect(entry).toMatchObject({ kind: 'decision-agent', pinnedVersion: 1 })
  })

  test('a generation agent still freezes as a generation entry', async () => {
    const agentId = await newGenerationAgent()
    const [entry] = await resolveRunManifest(db, graph([agentNode(agentId)]))
    expect(entry?.kind).toBe('agent')
  })

  test('two nodes on one agent yield ONE entry', async () => {
    const agentId = await newDecisionAgent()
    const manifest = await resolveRunManifest(
      db,
      graph([agentNode(agentId), { ...agentNode(agentId), id: 'judge2' }]),
    )
    expect(manifest).toHaveLength(1)
  })

  test('an unpublished agent resolves to nothing, leaving the node to say so at run time', async () => {
    const manifest = await resolveRunManifest(
      db,
      graph([agentNode('00000000-0000-0000-0000-000000000000')]),
    )
    expect(manifest).toEqual([])
  })
})
