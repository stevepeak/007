import { beforeEach, describe, expect, test } from 'bun:test'

import { makeAgentConfig } from '../../engine/agent-test-helpers'
import type { WorkflowGraph } from '../../engine/graph'
import { createWfDb, type WfDb } from '../client'
import { freshD1 } from '../db-test-helpers'

import { createAgent } from './authoring-agents'
import { resolveRunManifest } from './authoring-manifest'
import { upsertModels } from './models'

// Each agent entry freezes its model's context window, read from `wf_model` in
// one query for the whole manifest. A model the catalog doesn't know leaves the
// field off, so the engine's overflow guard stands down instead of guessing.

function agentNode(
  id: string,
  agentId: string,
): WorkflowGraph['nodes'][number] {
  return {
    id,
    kind: 'agent',
    label: id,
    position: { x: 0, y: 0 },
    informUser: { mode: 'off' },
    config: { agentId, version: null, inputs: {} },
  }
}

describe('resolveRunManifest — context length', () => {
  let db: WfDb
  beforeEach(async () => {
    // `createWfDb` over a D1 facade: `upsertModels` needs `db.batch`.
    db = createWfDb(freshD1())
    await upsertModels(db, 'venice', [
      {
        id: 'venice:big',
        modelId: 'big',
        label: 'Big',
        providerId: 'venice',
        contextLength: 128_000,
      },
      {
        id: 'venice:none',
        modelId: 'none',
        label: 'None',
        providerId: 'venice',
      },
    ])
  })

  const newAgent = async (name: string, modelId: string) => {
    const { agentId } = await createAgent(db, {
      name,
      config: makeAgentConfig({ modelId, prompt: 'Hi.' }),
    })
    return agentId
  }

  test('each agent entry carries its own model context length', async () => {
    const a = await newAgent('A', 'venice:big')
    const b = await newAgent('B', 'venice:big')
    const c = await newAgent('C', 'venice:none')
    const d = await newAgent('D', 'venice:uncatalogued')
    const manifest = await resolveRunManifest(db, {
      version: 1,
      nodes: [
        agentNode('a', a),
        agentNode('b', b),
        agentNode('c', c),
        agentNode('d', d),
      ],
      edges: [],
    })
    const byName = new Map(
      manifest.map((e) => [e.name, e.kind === 'agent' ? e : undefined]),
    )
    expect(byName.get('A')?.contextLength).toBe(128_000)
    expect(byName.get('B')?.contextLength).toBe(128_000)
    expect(byName.get('C')).not.toHaveProperty('contextLength')
    expect(byName.get('D')).not.toHaveProperty('contextLength')
  })
})
