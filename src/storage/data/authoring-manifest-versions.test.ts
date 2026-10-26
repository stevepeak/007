import { beforeEach, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'

import { makeAgentConfig } from '../../engine/agent-test-helpers'
import type { WorkflowGraph } from '../../engine/graph'
import type { WfDb } from '../client'
import { migratedSqlite } from '../db-test-helpers'
import { wfSchema } from '../schema'

import { createAgent, publishAgent } from './authoring-agents'
import { resolveRunManifest } from './authoring-manifest'

// A graph's agent versions resolve in one `wf_agent_version` read per level,
// not one per agent — the per-agent shape showed up in Sentry as an N+1 in the
// `resolve-manifest` step.

function agentNode(
  id: string,
  agentId: string,
  version: number | null = null,
): WorkflowGraph['nodes'][number] {
  return {
    id,
    kind: 'agent',
    label: id,
    position: { x: 0, y: 0 },
    informUser: { mode: 'off' },
    config: { agentId, version, inputs: {} },
  }
}

describe('resolveRunManifest — agent versions', () => {
  let db: WfDb
  let queries: string[]
  beforeEach(() => {
    queries = []
    db = drizzle(migratedSqlite(), {
      schema: wfSchema,
      logger: {
        logQuery: (q) => {
          queries.push(q)
        },
      },
    }) as unknown as WfDb
  })

  /** An agent with versions 1..`versions`, each prompt naming its number. */
  const newAgent = async (name: string, versions: number) => {
    const { agentId } = await createAgent(db, {
      name,
      config: makeAgentConfig({ prompt: 'v1' }),
    })
    for (let n = 2; n <= versions; n++) {
      await publishAgent(db, {
        agentId,
        config: makeAgentConfig({ prompt: `v${n}` }),
      })
    }
    return agentId
  }

  const versionReads = () => {
    return queries.filter((q) => q.includes('from "wf_agent_version"')).length
  }

  test('floating and pinned pins resolve to the right versions in one read', async () => {
    const a = await newAgent('A', 3)
    const b = await newAgent('B', 2)
    const c = await newAgent('C', 1)
    queries = []
    const manifest = await resolveRunManifest(db, {
      version: 1,
      nodes: [
        agentNode('a-latest', a),
        // Pinned to a number `a` also has, so the cross product over-selects.
        agentNode('a-pinned', a, 2),
        agentNode('b-pinned', b, 1),
        agentNode('c-latest', c),
        // A pin that was never published resolves to nothing.
        agentNode('c-missing', c, 9),
      ],
      edges: [],
    })
    expect(versionReads()).toBe(1)
    const resolved = manifest.map((e) => {
      return [
        e.name,
        e.kind === 'agent' ? e.pinnedVersion : undefined,
        e.kind === 'agent' ? e.versionNumber : undefined,
        e.kind === 'agent' ? e.config.prompt : undefined,
      ]
    })
    expect(resolved).toEqual([
      ['A', null, 3, 'v3'],
      ['A', 2, 2, 'v2'],
      ['B', 1, 1, 'v1'],
      ['C', null, 1, 'v1'],
    ])
  })
})
