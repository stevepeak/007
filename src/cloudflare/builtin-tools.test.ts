import { describe, expect, test } from 'bun:test'

import type { WfSdkConfig } from '../engine/config'
import type { ToolRegistryEntry } from '../engine/tool-registry'

import { defineWfConfig } from './builtin-tools'

// The root `defineWfConfig` is what makes `extract_text` / `create_document`
// appear with no host wiring. Pinned: they are registered, a host's own entry
// under the same id wins, and a run finds its bindings through `buildRunDeps`.

type Deps = { scope: string }

function baseConfig(
  toolRegistry: WfSdkConfig<Deps>['toolRegistry'] = new Map(),
): WfSdkConfig<Deps> {
  return {
    getModel: () => {
      throw new Error('unused')
    },
    listModels: () => [],
    listProviders: () => [],
    toolRegistry,
    buildRunDeps: () => ({ scope: 's' }),
    triggers: {},
  }
}

function fakeBucket(objects: Record<string, string>): R2Bucket {
  return {
    get: (key: string) => {
      const text = objects[key]
      return Promise.resolve(
        text === undefined
          ? null
          : {
              arrayBuffer: () => {
                return Promise.resolve(new TextEncoder().encode(text).buffer)
              },
            },
      )
    },
  } as unknown as R2Bucket
}

async function runExtract(args: {
  config: WfSdkConfig<Deps>
  env: unknown
}): Promise<unknown> {
  const deps = await args.config.buildRunDeps({
    triggerKind: 'playground',
    env: args.env,
  })
  const entry = args.config.toolRegistry.get('extract_text')
  if (entry?.kind !== 'function') throw new Error('extract_text missing')
  return await entry.build(deps)({
    source: 'notes.txt',
    filename: 'notes.txt',
    mimeType: 'text/plain',
  })
}

describe('built-in tools', () => {
  test('are registered with no host configuration', () => {
    const { toolRegistry } = defineWfConfig(baseConfig())
    expect(toolRegistry.get('extract_text')?.origin).toBe('sdk')
    expect(toolRegistry.get('create_document')?.origin).toBe('sdk')
  })

  test("a host's own entry under the same id wins", () => {
    const own: ToolRegistryEntry<Deps> = {
      id: 'extract_text',
      name: 'Mine',
      description: 'host override',
      kind: 'function',
      build: () => () => Promise.resolve('mine'),
    }
    const { toolRegistry } = defineWfConfig(
      baseConfig(new Map([['extract_text', own]])),
    )
    expect(toolRegistry.get('extract_text')).toBe(own)
  })

  test("read the run's bindings through buildRunDeps", async () => {
    const config = defineWfConfig(baseConfig())
    const result = await runExtract({
      config,
      env: { UPLOADS: fakeBucket({ 'notes.txt': 'hello' }) },
    })
    expect(result).toMatchObject({ text: 'hello', mode: 'passthrough' })
  })

  test('name the missing binding', async () => {
    const config = defineWfConfig(baseConfig())
    await expect(runExtract({ config, env: {} })).rejects.toThrow('`UPLOADS`')
  })
})
