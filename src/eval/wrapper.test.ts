import { describe, expect, test } from 'bun:test'

import { workflowGraphSchema } from '../engine/graph'
import { resolveGraphEngine } from '../engine/graph-engine'
import { parseStoredGraph } from '../storage/data/authoring-workflows'

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

  test('runs on the inline engine', () => {
    // One agent call with a caller waiting on it — none of what the durable
    // backend exists for, and its step-retry replay is what made a provider
    // outage take ~21 minutes per cell to report.
    expect(resolveGraphEngine(buildAgentWrapperGraph('agent-123'))).toBe('inline')
  })

  test('binds the Output to the agent', () => {
    // An unbound Output throws at run start ("has no bound value"), which is
    // how every eval against a pre-binding cached wrapper failed. The edge
    // alone is readiness, not a value.
    const graph = buildAgentWrapperGraph('agent-123')
    const agent = graph.nodes.find((n) => n.kind === 'agent')
    const output = graph.nodes.find((n) => n.kind === 'output')
    expect(output?.kind === 'output' && output.config.source).toEqual({
      kind: 'ref',
      nodeId: agent!.id,
      path: '',
    })
  })

  test('node ids are deterministic, so drift detection can compare graphs', () => {
    // `ensureAgentEvalWrapper` rebuilds the graph on every call and republishes
    // when it differs from the stored one. Random ids would differ every time
    // and republish forever.
    const a = buildAgentWrapperGraph('x')
    const b = buildAgentWrapperGraph('x')
    expect(a).toEqual(b)
  })

  test('survives a zod round-trip unchanged', () => {
    // Drift detection compares the fresh graph against the STORED one, which
    // `getVersionGraph` has run through `parseStoredGraph`. If the schema ever
    // gains a `.default()` the two would differ permanently and every eval cell
    // would publish a new wrapper version. Key REORDERING is fine —
    // `stableStringify` sorts — but added or dropped keys are not.
    const fresh = buildAgentWrapperGraph('agent-123')
    expect(parseStoredGraph(JSON.parse(JSON.stringify(fresh)))).toEqual(fresh)
  })

  test('different agents and pins get distinct node ids', () => {
    const x = buildAgentWrapperGraph('x')
    const y = buildAgentWrapperGraph('y')
    const pinned = buildAgentWrapperGraph('x', 3)
    const ids = (g: typeof x) => g.nodes.map((n) => n.id)
    expect(new Set([...ids(x), ...ids(y), ...ids(pinned)]).size).toBe(9)
  })
})

describe('evalWrapperName', () => {
  test('is a stable, prefixed cache key', () => {
    expect(evalWrapperName('agent-abc')).toBe(
      `${EVAL_WRAPPER_NAME_PREFIX}agent-abc`,
    )
  })
})
