import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import type { WfSdkConfig } from './config'
import { executeWorkflow } from './executor'
import type { Deps } from './executor-test-helpers'
import { workflowGraphSchema } from './graph'
import { createMemoryRunRecorder } from './run-recorder'
import type { ToolRegistry } from './tool-registry'

// trigger → switch(on the trigger's `kind`) → [A|B|else] tool → its own
// output. Each arm routes to a distinct output so the run returns the arm that
// fired. Case A is a literal the author typed; case B is a REF — it matches when
// `kind` equals another upstream value (here the trigger's own `expected`),
// which is the second way the editor lets a case be filled in.
function switchGraph() {
  const armTool = (id: string, toolId: string, x: number) => ({
    id,
    kind: 'tool' as const,
    label: id,
    position: { x, y: 0 },
    config: { toolId, args: {} },
  })
  const armOut = (id: string, x: number) => ({
    id,
    kind: 'output' as const,
    label: id,
    position: { x, y: 0 },
    // Each arm's Output returns its own producing tool (a-out ← a-tool …).
    config: {
      source: {
        kind: 'ref' as const,
        nodeId: id.replace('-out', '-tool'),
        path: '',
      },
    },
  })
  return {
    version: 1 as const,
    nodes: [
      {
        id: 't',
        kind: 'trigger',
        label: 'Go',
        position: { x: 0, y: 0 },
        config: { triggerKind: 'go' },
      },
      {
        id: 'sw',
        kind: 'switch',
        label: 'By kind',
        position: { x: 200, y: 0 },
        config: {
          source: { kind: 'ref' as const, nodeId: 't', path: 'kind' },
          cases: [
            { key: 'A', value: { kind: 'literal' as const, value: 'image' } },
            {
              key: 'B',
              value: { kind: 'ref' as const, nodeId: 't', path: 'expected' },
            },
          ],
        },
      },
      armTool('a-tool', 'label-a', 400),
      armTool('b-tool', 'label-b', 400),
      armTool('else-tool', 'label-else', 400),
      armOut('a-out', 600),
      armOut('b-out', 600),
      armOut('else-out', 600),
    ],
    edges: [
      { id: 'e0', source: 't', target: 'sw', condition: null },
      { id: 'e-a', source: 'sw', target: 'a-tool', condition: 'A' },
      { id: 'e-b', source: 'sw', target: 'b-tool', condition: 'B' },
      { id: 'e-else', source: 'sw', target: 'else-tool', condition: 'else' },
      { id: 'e-ao', source: 'a-tool', target: 'a-out', condition: null },
      { id: 'e-bo', source: 'b-tool', target: 'b-out', condition: null },
      { id: 'e-eo', source: 'else-tool', target: 'else-out', condition: null },
    ],
  }
}

// Distinct constant per arm so the returned output identifies the arm that ran.
const switchTools: ToolRegistry<Deps> = new Map(
  (['a', 'b', 'else'] as const).map((k) => [
    `label-${k}`,
    {
      id: `label-${k}`,
      name: k,
      kind: 'function',
      description: k,
      build: () => () => Promise.resolve({ arm: k }),
    },
  ]),
)

function switchConfig(): WfSdkConfig<Deps> {
  return {
    getModel: () => {
      throw new Error('no model needed')
    },
    listModels: () => [],
    listProviders: () => [],
    toolRegistry: switchTools,
    triggers: {
      go: {
        description: 'Go',
        inputSchema: z.object({ kind: z.string(), expected: z.string() }),
      },
    },
    buildRunDeps: (ctx) => ({ subject: ctx.subjectId ?? '' }),
  }
}

describe('executor — switch (multi-way routing)', () => {
  test('routes to the matching case arm', async () => {
    const recorder = createMemoryRunRecorder()
    const result = await executeWorkflow({
      graph: switchGraph(),
      triggerInput: { kind: 'image', expected: 'audio' },
      config: switchConfig(),
      runContext: { subjectId: 'acme', triggerKind: 'go' },
      recorder,
    })
    expect(result.output).toEqual({ arm: 'a' })
    expect(result.outputNodeId).toBe('a-out')
    // The switch step records its decision as the winning case key.
    const sw = recorder.steps.find((s) => s.nodeId === 'sw')
    expect(sw?.branchResult?.result).toBe('A')
    // The other arms never ran.
    expect(recorder.steps.some((s) => s.nodeId === 'b-tool')).toBe(false)
    expect(recorder.steps.some((s) => s.nodeId === 'else-tool')).toBe(false)
  })

  test('matches a case bound to another upstream value', async () => {
    const result = await executeWorkflow({
      graph: switchGraph(),
      // Case B compares `kind` against the trigger's `expected` — equal here.
      triggerInput: { kind: 'audio', expected: 'audio' },
      config: switchConfig(),
      runContext: { subjectId: 'acme', triggerKind: 'go' },
      recorder: createMemoryRunRecorder(),
    })
    expect(result.output).toEqual({ arm: 'b' })
    expect(result.outputNodeId).toBe('b-out')
  })

  test('falls back to the else arm when no case matches', async () => {
    const result = await executeWorkflow({
      graph: switchGraph(),
      triggerInput: { kind: 'audio', expected: 'video' },
      config: switchConfig(),
      runContext: { subjectId: 'acme', triggerKind: 'go' },
      recorder: createMemoryRunRecorder(),
    })
    expect(result.output).toEqual({ arm: 'else' })
    expect(result.outputNodeId).toBe('else-out')
  })

  // The 'else' arm is optional: like an unconnected branch arm, an unmatched
  // input just fizzles out. The editor still warns (graph-issues.ts).
  test('accepts a switch with no else edge', () => {
    const g = switchGraph()
    g.edges = g.edges.filter((e) => e.id !== 'e-else')
    expect(() => workflowGraphSchema.parse(g)).not.toThrow()
  })

  test('an unmatched input with no else edge stops there', async () => {
    const g = switchGraph()
    g.edges = g.edges.filter((e) => e.id !== 'e-else')
    const recorder = createMemoryRunRecorder()
    const result = await executeWorkflow({
      graph: g,
      triggerInput: { kind: 'audio', expected: 'video' },
      config: switchConfig(),
      runContext: { subjectId: 'acme', triggerKind: 'go' },
      recorder,
    })
    // No arm is alive, so the run ends with no output rather than erroring.
    expect(result.outputNodeId).toBeNull()
    expect(result.output).toBeUndefined()
    expect(recorder.steps.some((s) => s.nodeId === 'else-tool')).toBe(false)
  })

  test('rejects an outgoing edge matching no declared case', () => {
    const g = switchGraph()
    g.edges = g.edges.map((e) =>
      e.id === 'e-a' ? { ...e, condition: 'nope' } : e,
    )
    expect(() => workflowGraphSchema.parse(g)).toThrow(/matches no declared case/)
  })
})
