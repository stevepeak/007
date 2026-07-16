import { describe, expect, test } from 'bun:test'

import { agentFromManifest, type WfRunManifestEntry } from './graph'

// The run manifest keys agent entries by (agentId, pin). A node that floats to
// latest (`version: null`) and a node that pins a specific version can both
// reference the same agent in one run, so each must resolve to its own frozen
// config.

const agentConfig = (prompt: string) => ({
  modelId: 'mock',
  prompt,
  toolIds: [],
  maxTurns: 1,
  exposeThinking: false,
  output: { kind: 'text' as const },
})

const MANIFEST: WfRunManifestEntry[] = [
  {
    kind: 'agent',
    id: 'a1',
    pinnedVersion: null,
    versionId: 'a1-v5',
    versionNumber: 5,
    name: 'A1',
    config: agentConfig('latest'),
  },
  {
    kind: 'agent',
    id: 'a1',
    pinnedVersion: 2,
    versionId: 'a1-v2',
    versionNumber: 2,
    name: 'A1',
    config: agentConfig('pinned-v2'),
  },
]

describe('agentFromManifest — pin-aware lookup', () => {
  test('null pin resolves the float-to-latest entry', () => {
    const entry = agentFromManifest(MANIFEST, 'a1', null)
    expect(entry?.versionNumber).toBe(5)
    expect(entry?.config.prompt).toBe('latest')
  })

  test('omitted pin defaults to latest', () => {
    expect(agentFromManifest(MANIFEST, 'a1')?.versionNumber).toBe(5)
  })

  test('a numeric pin resolves that exact version, not latest', () => {
    const entry = agentFromManifest(MANIFEST, 'a1', 2)
    expect(entry?.versionNumber).toBe(2)
    expect(entry?.config.prompt).toBe('pinned-v2')
  })

  test('a pin with no matching entry resolves to nothing', () => {
    expect(agentFromManifest(MANIFEST, 'a1', 9)).toBeUndefined()
    expect(agentFromManifest(MANIFEST, 'missing', null)).toBeUndefined()
  })
})
