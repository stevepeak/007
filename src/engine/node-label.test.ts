import { describe, expect, it } from 'bun:test'

import { nodeSpanLabel } from './node-label'
import type { WfRunManifestEntry } from './run-manifest'

// `config`/`graph` aren't read by nodeSpanLabel; cast keeps the fixtures terse.
const MANIFEST = [
  {
    kind: 'agent',
    id: 'a1',
    pinnedVersion: null,
    versionId: 'v-latest',
    versionNumber: 5,
    name: 'Legal Researcher',
    config: {},
  },
  {
    kind: 'workflow',
    id: 'w1',
    versionId: 'wv1',
    versionNumber: 2,
    name: 'Intake Pipeline',
    graph: { id: 'g', nodes: [], edges: [] },
  },
] as unknown as WfRunManifestEntry[]

describe('nodeSpanLabel', () => {
  it('folds the resolved agent name and node label together', () => {
    const label = nodeSpanLabel(
      { kind: 'agent', label: 'Draft the memo', config: { agentId: 'a1' } },
      MANIFEST,
    )
    expect(label).toBe('Agent: Legal Researcher - Draft the memo')
  })

  it('honors the version pin when resolving the agent', () => {
    const pinned = [
      { ...MANIFEST[0], pinnedVersion: 3, versionNumber: 3, name: 'Old Name' },
    ] as unknown as WfRunManifestEntry[]
    const label = nodeSpanLabel(
      {
        kind: 'agent',
        label: 'Draft',
        config: { agentId: 'a1', version: 3 },
      },
      pinned,
    )
    expect(label).toBe('Agent: Old Name - Draft')
  })

  it('falls back to just the node label when the agent is unresolved', () => {
    const label = nodeSpanLabel(
      { kind: 'agent', label: 'Draft the memo', config: { agentId: 'missing' } },
      MANIFEST,
    )
    expect(label).toBe('Agent: Draft the memo')
  })

  it('prefixes decision nodes with a pretty kind', () => {
    expect(
      nodeSpanLabel({ kind: 'branch', label: 'Has prior rulings?' }),
    ).toBe('Branch: Has prior rulings?')
    expect(nodeSpanLabel({ kind: 'switch', label: 'Route by type' })).toBe(
      'Switch: Route by type',
    )
  })

  it('folds the resolved workflow name in', () => {
    const label = nodeSpanLabel(
      { kind: 'workflow', label: 'Run intake', config: { workflowId: 'w1' } },
      MANIFEST,
    )
    expect(label).toBe('Workflow: Intake Pipeline - Run intake')
  })

  it('falls back to the bare kind when there is no label', () => {
    expect(nodeSpanLabel({ kind: 'branch' })).toBe('Branch')
  })
})
