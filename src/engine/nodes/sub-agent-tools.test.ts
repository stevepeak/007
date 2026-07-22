import { describe, expect, test } from 'bun:test'

import type { SubAgentTarget } from '../graph'

import {
  spawnInputSchema,
  synthesizeTargets,
  type TargetDisplay,
} from './sub-agent-tools'

// The pure synthesis layer: deterministic, collision-free tool names and the
// per-target input schema shape. Shared by the runtime and the editor preview.

const agent = (id: string, extra: Partial<SubAgentTarget> = {}): SubAgentTarget => ({
  kind: 'agent',
  id,
  version: null,
  ...extra,
})

describe('synthesizeTargets — naming', () => {
  test('derives spawn_<slug> from the display name', () => {
    const [info] = synthesizeTargets([agent('a')], () => ({
      displayName: 'Legal Research!',
    }))
    expect(info.toolName).toBe('spawn_legal_research')
  })

  test('honors an explicit toolName override verbatim', () => {
    const [info] = synthesizeTargets([agent('a', { toolName: 'do_research' })], () => ({
      displayName: 'Anything',
    }))
    expect(info.toolName).toBe('do_research')
  })

  test('disambiguates colliding names deterministically', () => {
    const display = (): TargetDisplay => ({ displayName: 'Research' })
    const names = synthesizeTargets([agent('a'), agent('b')], display).map(
      (i) => i.toolName,
    )
    expect(names).toEqual(['spawn_research', 'spawn_research_2'])
  })
})

describe('spawnInputSchema', () => {
  test('agent target: message + one optional field per prompt variable', () => {
    const [info] = synthesizeTargets([agent('a')], () => ({
      displayName: 'Researcher',
      promptVariables: ['topic', 'depth'],
    }))
    const schema = spawnInputSchema(info)
    expect(schema.safeParse({ message: 'go', topic: 't' }).success).toBe(true)
    // `message` is required.
    expect(schema.safeParse({ topic: 't' }).success).toBe(false)
    // Prompt vars are optional.
    expect(schema.safeParse({ message: 'go' }).success).toBe(true)
  })

  test('workflow target: a free-form input', () => {
    const wf: SubAgentTarget = { kind: 'workflow', id: 'w', version: null }
    const [info] = synthesizeTargets([wf], () => ({ displayName: 'Pipeline' }))
    const schema = spawnInputSchema(info)
    expect(schema.safeParse({ input: { any: 'thing' } }).success).toBe(true)
  })
})
