import { z } from 'zod'

import type { WfSdkConfig } from './config'
import type { ToolRegistry } from './tool-registry'

// Covers the three SDK capabilities added for the recipe-ingestion redesign,
// all through the in-process backend (no DB, no Cloudflare):
//   1. onRunComplete / onRunFailed lifecycle callbacks
//   2. per-node `continueOnError` (best-effort nodes)
//   3. the provider-agnostic `execution` policy schema (retry/timeout shape)
// The Cloudflare backend maps #2/#3 onto `step.do`; that mapping can't be
// imported here (it pulls in `cloudflare:workers`), so we assert the engine-side
// contract both backends share.

export type Deps = { subject: string }

export const toolRegistry: ToolRegistry<Deps> = new Map([
  [
    'boom',
    {
      id: 'boom',
      name: 'Boom',
      kind: 'function',
      description: 'Always throws.',
      // eslint-disable-next-line @typescript-eslint/require-await
      build: () => async () => {
        throw new Error('boom failed')
      },
    },
  ],
  [
    'after',
    {
      id: 'after',
      name: 'After',
      kind: 'function',
      description: 'Returns a constant regardless of input.',
      build: () => () => Promise.resolve({ ok: true }),
    },
  ],
  [
    'left',
    {
      id: 'left',
      name: 'Left',
      kind: 'function',
      description: 'Produces the left result.',
      build: () => () => Promise.resolve({ v: 'L' }),
    },
  ],
  [
    'right',
    {
      id: 'right',
      name: 'Right',
      kind: 'function',
      description: 'Produces the right result.',
      build: () => () => Promise.resolve({ v: 'R' }),
    },
  ],
])

export function makeConfig(
  hooks: Partial<Pick<WfSdkConfig<Deps>, 'onRunComplete' | 'onRunFailed'>> = {},
): WfSdkConfig<Deps> {
  return {
    getModel: () => {
      throw new Error('no model needed')
    },
    listModels: () => [],
    listProviders: () => [],
    toolRegistry,
    triggers: {
      go: { description: 'Go', inputSchema: z.object({ n: z.number() }) },
    },
    buildRunDeps: (ctx) => ({ subject: ctx.subjectId ?? '' }),
    ...hooks,
  }
}

// trigger → boom → after → output. `boom` always fails; whether the run aborts
// or reaches `after`/output is decided by boom's `execution.continueOnError`.
export function chainGraph(boomExecution?: Record<string, unknown>) {
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
        id: 'boom',
        kind: 'tool',
        label: 'Boom',
        position: { x: 200, y: 0 },
        ...(boomExecution ? { execution: boomExecution } : {}),
        config: { toolId: 'boom', args: {} },
      },
      {
        id: 'after',
        kind: 'tool',
        label: 'After',
        position: { x: 400, y: 0 },
        config: { toolId: 'after', args: {} },
      },
      {
        id: 'o',
        kind: 'output',
        label: 'Out',
        position: { x: 600, y: 0 },
        config: {},
      },
    ],
    edges: [
      { id: 'e1', source: 't', target: 'boom', condition: null },
      { id: 'e2', source: 'boom', target: 'after', condition: null },
      { id: 'e3', source: 'after', target: 'o', condition: null },
    ],
  }
}
