import { describe, expect, test } from 'bun:test'

import { workflowGraphSchema } from '../engine/graph'

import {
  buildAgentWrapperGraph,
  evalWrapperName,
  EVAL_WRAPPER_NAME_PREFIX,
} from './wrapper'

// Phase 5 — the wrapper graph builder is pure; the db-backed `ensureAgentEvalWrapper`
// / `resolveEvalTarget` are covered by typecheck + the handler path (no db test
// harness in this repo).

describe('buildAgentWrapperGraph', () => {
  test('produces a runnable trigger → agent → output graph', () => {
    const graph = buildAgentWrapperGraph('agent-123')
    // The strict runtime gate (single trigger, reachable output, legal joins).
    const parsed = workflowGraphSchema.parse(graph)
    expect(parsed.nodes).toHaveLength(3)

    const trigger = parsed.nodes.find((n) => n.kind === 'trigger')
    const agent = parsed.nodes.find((n) => n.kind === 'agent')
    const output = parsed.nodes.find((n) => n.kind === 'output')
    expect(trigger?.config).toMatchObject({ triggerKind: 'manual' })
    expect(agent?.kind === 'agent' && agent.config.agentId).toBe('agent-123')
    expect(output).toBeDefined()

    // Wired trigger → agent → output (two edges, no danglers).
    expect(parsed.edges).toHaveLength(2)
    expect(parsed.edges[0]?.source).toBe(trigger!.id)
    expect(parsed.edges[0]?.target).toBe(agent!.id)
    expect(parsed.edges[1]?.source).toBe(agent!.id)
    expect(parsed.edges[1]?.target).toBe(output!.id)
  })

  test('fresh node ids each call (no cross-graph id collisions)', () => {
    const a = buildAgentWrapperGraph('x')
    const b = buildAgentWrapperGraph('x')
    expect(a.nodes[0]?.id).not.toBe(b.nodes[0]?.id)
  })
})

describe('evalWrapperName', () => {
  test('is a stable, prefixed cache key', () => {
    expect(evalWrapperName('agent-abc')).toBe(
      `${EVAL_WRAPPER_NAME_PREFIX}agent-abc`,
    )
  })
})
