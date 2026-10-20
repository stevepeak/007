import { describe, expect, test } from 'bun:test'

import type { RunContext, RunFlags, WfSdkConfig } from './config'
import { buildRunNodeContext } from './run-node'

// Every backend builds its node context through `buildRunNodeContext`, so these
// pin what reaches a node: the run flags (dropped one at a time by hand-copied
// literals before) and the per-call model options.

const flags: Required<RunFlags> = {
  simulate: true,
  fixtures: { search: { hits: [] } },
  liveReads: true,
  toolModes: { search: 'live' },
  freezeTools: true,
  agentOverride: { modelId: 'override-model' },
}

function makeConfig(seen: { modelId: string; ctx: RunContext }[]) {
  const config: WfSdkConfig<null> = {
    getModel: (modelId, ctx) => {
      seen.push({ modelId, ctx })
      return {} as ReturnType<WfSdkConfig<null>['getModel']>
    },
    listModels: () => [],
    listProviders: () => [],
    toolRegistry: new Map(),
    triggers: {},
    buildRunDeps: () => null,
  }
  return config
}

describe('buildRunNodeContext', () => {
  test('carries every run flag from the run context', () => {
    const ctx = buildRunNodeContext({
      config: makeConfig([]),
      runContext: { triggerKind: 'go', ...flags },
      toolDeps: null,
      nodeOutputs: new Map(),
    })
    for (const [key, value] of Object.entries(flags)) {
      expect(ctx[key as keyof RunFlags]).toEqual(value)
    }
  })

  test('forwards per-call web search and reasoning to the host', () => {
    const seen: { modelId: string; ctx: RunContext }[] = []
    const ctx = buildRunNodeContext({
      config: makeConfig(seen),
      runContext: { triggerKind: 'go', reasoning: true },
      toolDeps: null,
      nodeOutputs: new Map(),
    })
    ctx.getModel('m', {
      reasoning: false,
      webSearch: 'auto',
      webCitations: true,
    })
    expect(seen).toHaveLength(1)
    expect(seen[0].ctx.reasoning).toBe(false)
    expect(seen[0].ctx.webSearch).toBe('auto')
    expect(seen[0].ctx.webCitations).toBe(true)
  })

  test('an explicit manifest wins over the run context one', () => {
    const ctx = buildRunNodeContext({
      config: makeConfig([]),
      runContext: { triggerKind: 'go', manifest: [] },
      toolDeps: null,
      nodeOutputs: new Map(),
      manifest: [
        {
          kind: 'agent',
          id: 'a',
          pinnedVersion: null,
          versionId: 'v',
          versionNumber: 1,
          name: 'A',
          config: {} as never,
        },
      ],
    })
    expect(ctx.manifest).toHaveLength(1)
  })
})
