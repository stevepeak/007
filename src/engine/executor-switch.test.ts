import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import type { WfSdkConfig } from './config'
import { executeWorkflow } from './executor'
import { workflowGraphSchema } from './graph'
import { createMemoryRunRecorder } from './run-recorder'
import type { ToolRegistry } from './tool-registry'
import type { Deps } from './executor-test-helpers'

// trigger → switch(on `kind`) → [text|image|default] tool → its own output.
// Each arm routes to a distinct output so the run returns the arm that fired.
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
    config: {},
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
          path: 'kind',
          cases: [
            { key: 'text', value: 'text' },
            { key: 'image', value: 'image' },
          ],
        },
      },
      armTool('text-tool', 'label-text', 400),
      armTool('image-tool', 'label-image', 400),
      armTool('default-tool', 'label-default', 400),
      armOut('text-out', 600),
      armOut('image-out', 600),
      armOut('default-out', 600),
    ],
    edges: [
      { id: 'e0', source: 't', target: 'sw', condition: null },
      { id: 'e-text', source: 'sw', target: 'text-tool', condition: 'text' },
      { id: 'e-image', source: 'sw', target: 'image-tool', condition: 'image' },
      {
        id: 'e-def',
        source: 'sw',
        target: 'default-tool',
        condition: 'default',
      },
      { id: 'e-to', source: 'text-tool', target: 'text-out', condition: null },
      {
        id: 'e-io',
        source: 'image-tool',
        target: 'image-out',
        condition: null,
      },
      {
        id: 'e-do',
        source: 'default-tool',
        target: 'default-out',
        condition: null,
      },
    ],
  }
}

// Distinct constant per arm so the returned output identifies the arm that ran.
const switchTools: ToolRegistry<Deps> = new Map(
  (['text', 'image', 'default'] as const).map((k) => [
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
      go: { description: 'Go', inputSchema: z.object({ kind: z.string() }) },
    },
    buildRunDeps: (ctx) => ({ subject: ctx.subjectId ?? '' }),
  }
}

describe('executor — switch (multi-way routing)', () => {
  test('routes to the matching case arm', async () => {
    const recorder = createMemoryRunRecorder()
    const result = await executeWorkflow({
      graph: switchGraph(),
      triggerInput: { kind: 'image' },
      config: switchConfig(),
      runContext: { subjectId: 'acme', triggerKind: 'go' },
      recorder,
    })
    expect(result.output).toEqual({ arm: 'image' })
    expect(result.outputNodeId).toBe('image-out')
    // The switch step records its decision as the winning case key.
    const sw = recorder.steps.find((s) => s.nodeId === 'sw')
    expect(sw?.branchResult?.result).toBe('image')
    // The other arms never ran.
    expect(recorder.steps.some((s) => s.nodeId === 'text-tool')).toBe(false)
    expect(recorder.steps.some((s) => s.nodeId === 'default-tool')).toBe(false)
  })

  test('falls back to the default arm when no case matches', async () => {
    const result = await executeWorkflow({
      graph: switchGraph(),
      triggerInput: { kind: 'audio' },
      config: switchConfig(),
      runContext: { subjectId: 'acme', triggerKind: 'go' },
      recorder: createMemoryRunRecorder(),
    })
    expect(result.output).toEqual({ arm: 'default' })
    expect(result.outputNodeId).toBe('default-out')
  })

  test('rejects a switch missing its default edge', () => {
    const g = switchGraph()
    g.edges = g.edges.filter((e) => e.id !== 'e-def')
    expect(() => workflowGraphSchema.parse(g)).toThrow(/default/)
  })

  test('rejects an outgoing edge matching no declared case', () => {
    const g = switchGraph()
    g.edges = g.edges.map((e) =>
      e.id === 'e-text' ? { ...e, condition: 'nope' } : e,
    )
    expect(() => workflowGraphSchema.parse(g)).toThrow(/matches no declared case/)
  })
})
