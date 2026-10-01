import { beforeEach, describe, expect, test } from 'bun:test'

import { MANUAL_TRIGGER_KIND, type AgentConfig } from '../../engine'
import { makeAgentConfig } from '../../engine/agent-test-helpers'
import type { WfDb } from '../client'
import { freshDb } from '../db-test-helpers'

import { exportBundle } from './export'
import { graphIdsToSlugs, graphSlugsToIds } from './graph-refs'
import { importBundle } from './import'
import type { SpecBundle } from './spec-schema'

// ── in-memory WfDb built from the real migration chain ────────────────────────

// ── a small bundle: an agent + a workflow whose graph uses the agent (by slug)
//    + an eval targeting the agent ──────────────────────────────────────────────

function sampleBundle(prompt = 'Say hello to ${name}.'): SpecBundle {
  return {
    formatVersion: 1,
    agents: [
      {
        kind: 'agent',
        slug: 'greeter',
        name: 'Greeter',
        agentKind: 'generation',
        description: 'Greets people',
        config: makeAgentConfig({
          modelId: 'test-model',
          prompt,
          toolIds: [],
          maxTurns: 5,
          output: { kind: 'text' },
          subAgents: {
            targets: [],
            maxConcurrent: 4,
            maxSpawns: 10,
            allowStopSignal: true,
          },
        }),
      },
    ],
    workflows: [
      {
        kind: 'workflow',
        slug: 'greet-flow',
        name: 'Greet flow',
        triggers: [MANUAL_TRIGGER_KIND],
        graph: {
          version: 1,
          nodes: [
            {
              id: 'trg',
              kind: 'trigger',
              label: 'Manual start',
              position: { x: 0, y: 0 },
              config: { triggerKind: MANUAL_TRIGGER_KIND },
            },
            {
              id: 'agt',
              kind: 'agent',
              label: 'Greeter',
              position: { x: 160, y: 0 },
              config: { agentSlug: 'greeter', inputs: {} },
            },
            {
              id: 'out',
              kind: 'output',
              label: 'Output',
              position: { x: 320, y: 0 },
              config: {},
            },
          ],
          edges: [
            { id: 'e1', source: 'trg', target: 'agt', condition: null },
            { id: 'e2', source: 'agt', target: 'out', condition: null },
          ],
        },
      },
    ],
    evals: [
      {
        kind: 'eval',
        slug: 'greeter-goal',
        name: 'Greeter goal',
        targetKind: 'agent',
        target: 'greeter',
        triggerKind: MANUAL_TRIGGER_KIND,
        rows: [{ name: 'basic' }],
      },
    ],
  }
}

describe('graph-refs', () => {
  test('id↔slug translation round-trips and recurses into iteration subgraphs', () => {
    const dbGraph = {
      version: 1,
      nodes: [
        {
          id: 'a',
          kind: 'agent',
          config: { agentId: 'uuid-1', version: null },
        },
        {
          id: 'i',
          kind: 'iteration',
          config: {
            subgraph: {
              nodes: [
                { id: 'b', kind: 'agent', config: { agentId: 'uuid-2' } },
                { id: 'w', kind: 'workflow', config: { workflowId: 'uuid-3' } },
              ],
            },
          },
        },
      ],
    }
    const toSlug = graphIdsToSlugs(dbGraph, {
      agentSlugById: new Map([
        ['uuid-1', 'alpha'],
        ['uuid-2', 'beta'],
      ]),
      workflowSlugById: new Map([['uuid-3', 'wf']]),
    })
    const back = graphSlugsToIds(toSlug, {
      agentIdBySlug: new Map([
        ['alpha', 'uuid-1'],
        ['beta', 'uuid-2'],
      ]),
      workflowIdBySlug: new Map([['wf', 'uuid-3']]),
    })
    expect(back).toEqual(dbGraph)
  })

  test('unknown slug throws with context', () => {
    expect(() => {
      return graphSlugsToIds(
        {
          version: 1,
          nodes: [{ id: 'a', kind: 'agent', config: { agentSlug: 'missing' } }],
        },
        { agentIdBySlug: new Map(), workflowIdBySlug: new Map() },
      )
    }).toThrow(/agent slug "missing"/)
  })
})

describe('import/export round-trip', () => {
  let db: WfDb
  beforeEach(() => {
    db = freshDb()
  })

  test('import creates entities, export reproduces the bundle', async () => {
    const report = await importBundle(db, sampleBundle())
    expect(report.changes.map((c) => c.action)).toEqual([
      'create',
      'create',
      'create',
    ])

    const out = await exportBundle(db)
    expect(out.agents.map((a) => a.slug)).toEqual(['greeter'])
    expect(out.workflows.map((w) => w.slug)).toEqual(['greet-flow'])
    expect(out.evals.map((e) => e.slug)).toEqual(['greeter-goal'])

    // The workflow graph's agent node came back as a slug, not a UUID.
    const graph = out.workflows[0].graph as {
      nodes: { kind: string; config: Record<string, unknown> }[]
    }
    const agentNode = graph.nodes.find((n) => n.kind === 'agent')!
    expect(agentNode.config.agentSlug).toBe('greeter')
    expect(agentNode.config.agentId).toBeUndefined()

    // Trigger assignment round-tripped.
    expect(out.workflows[0].triggers).toEqual([MANUAL_TRIGGER_KIND])
    // Eval target came back as the agent slug.
    expect(out.evals[0].target).toBe('greeter')
  })

  test('re-importing an unchanged bundle is a no-op', async () => {
    await importBundle(db, sampleBundle())
    const report = await importBundle(db, sampleBundle())
    expect(report.clean).toBe(true)
    expect(report.changes.every((c) => c.action === 'unchanged')).toBe(true)
  })

  test('a changed agent config publishes a new version', async () => {
    await importBundle(db, sampleBundle())
    const report = await importBundle(
      db,
      sampleBundle('A different prompt ${name}.'),
    )
    const agent = report.changes.find((c) => c.kind === 'agent')!
    expect(agent.action).toBe('update')

    // Export reflects the new prompt.
    const out = await exportBundle(db)
    expect((out.agents[0].config as AgentConfig).prompt).toBe(
      'A different prompt ${name}.',
    )
  })

  test('dry-run reports changes without writing', async () => {
    const report = await importBundle(db, sampleBundle(), { dryRun: true })
    expect(report.changes.every((c) => c.action === 'create')).toBe(true)
    const out = await exportBundle(db)
    expect(out.agents).toHaveLength(0)
  })
})

// ── decision agents (ART-238) ────────────────────────────────────────────────

describe('spec round trip for a decision agent', () => {
  let db: WfDb
  beforeEach(() => {
    db = freshDb()
  })

  const decisionBundle = (prompt = 'Is this urgent?'): SpecBundle => ({
    formatVersion: 1,
    agents: [
      {
        kind: 'agent',
        slug: 'triage',
        name: 'Triage',
        agentKind: 'decision',
        config: {
          modelId: 'venice:jev-latest',
          questions: [
            {
              id: 'is_urgent',
              type: 'boolean',
              prompt,
              considerations: { overdue: 'No reply in 48h' },
              choices: [],
              threshold: 0.7,
            },
          ],
          verdicts: ['escalate', 'auto_reply'],
          rules: [
            {
              id: 'r1',
              verdict: 'escalate',
              conditions: [{ questionId: 'is_urgent', op: 'is', yes: true, keys: [] }],
            },
            { id: 'r2', verdict: 'auto_reply', conditions: [] },
          ],
        },
      },
    ],
    workflows: [],
    evals: [],
  })

  test('imports, exports and re-imports as unchanged', async () => {
    await importBundle(db, decisionBundle())
    const out = await exportBundle(db)
    expect(out.agents[0].agentKind).toBe('decision')
    // The considerations survive the round trip — they are the one field no
    // other authoring surface could set, so losing them here would put the
    // feature straight back out of reach.
    expect(out.agents[0].config).toMatchObject({
      questions: [{ considerations: { overdue: 'No reply in 48h' } }],
    })

    const again = await importBundle(db, out)
    expect(again.changes.every((c) => c.action === 'unchanged')).toBe(true)
  })

  test('a changed question publishes a new version', async () => {
    await importBundle(db, decisionBundle())
    const report = await importBundle(db, decisionBundle('Is this REALLY urgent?'))
    expect(report.changes.find((c) => c.kind === 'agent')?.action).toBe('update')
  })

  test('changing an agent’s KIND is refused rather than published over', async () => {
    // Two different agents sharing a slug, not an update — the configs are
    // disjoint, so publishing one over the other writes a row nothing reads.
    await importBundle(db, decisionBundle())
    const clash: SpecBundle = {
      ...decisionBundle(),
      agents: [
        {
          ...decisionBundle().agents[0],
          agentKind: 'generation',
          config: makeAgentConfig({ modelId: 'test-model', prompt: 'Hi.' }),
        },
      ],
    }
    await expect(importBundle(db, clash)).rejects.toThrow(/kind cannot change/)
  })

  test('a spec with no agentKind reads as a generation agent', async () => {
    // Every spec file written before ART-238 — the default IS the migration.
    const legacy = {
      formatVersion: 1,
      agents: [
        {
          kind: 'agent',
          slug: 'legacy',
          name: 'Legacy',
          config: makeAgentConfig({ modelId: 'test-model', prompt: 'Hi.' }),
        },
      ],
      workflows: [],
      evals: [],
    }
    await importBundle(db, legacy)
    const out = await exportBundle(db)
    expect(out.agents[0].agentKind).toBe('generation')
  })
})
