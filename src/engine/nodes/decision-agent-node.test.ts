import { describe, expect, test } from 'bun:test'

import type { DecisionAgentConfig } from '../decision-agent-schema'
import { starterDecisionAgentConfig } from '../decision-agent-schema'
import type { AgentNode, Decider, DecisionRequest } from '../graph'
import type { WfRunManifestEntry } from '../run-manifest'

import {
  executeDecisionAgentNode,
  isDecisionAgentNode,
} from './decision-agent'

// An Agent node pointed at a decision AGENT — the only way a decision agent
// reaches a run. Everything the agent owns (questions, thresholds, verdicts,
// rules, decider) comes out of the frozen manifest entry; the node contributes
// only the subject being judged (and any `${variables}` its inputs bind).
//
// What is pinned here is the seam: the node must run the AGENT's config and not
// its own, must roll the answers up to one verdict (which is the point — a
// Switch routes on that), and must refuse rather than improvise when the
// reference does not resolve.

function agentConfig(over: Partial<DecisionAgentConfig> = {}): DecisionAgentConfig {
  const starter = starterDecisionAgentConfig('agent:decider')
  return {
    ...starter,
    questions: starter.questions.map((q) => ({ ...q, prompt: 'Needs review?' })),
    ...over,
  }
}

function manifest(
  config: DecisionAgentConfig = agentConfig(),
  over: Partial<Extract<WfRunManifestEntry, { kind: 'decision-agent' }>> = {},
): WfRunManifestEntry[] {
  return [
    {
      kind: 'decision-agent',
      id: 'triage',
      pinnedVersion: null,
      versionId: 'v-1',
      versionNumber: 3,
      name: 'Triage',
      config,
      ...over,
    },
  ]
}

function node(config: Partial<AgentNode['config']> = {}): AgentNode {
  return {
    id: 'judge',
    kind: 'agent',
    label: 'Judge',
    position: { x: 0, y: 0 },
    informUser: { mode: 'off' },
    config: {
      agentId: 'triage',
      version: null,
      inputs: {},
      ...config,
    },
  }
}

function stubDecider(probability = 0.91): {
  decide: Decider
  calls: DecisionRequest[]
  models: string[]
} {
  const calls: DecisionRequest[] = []
  const models: string[] = []
  const decide: Decider = (request) => {
    calls.push(request)
    return Promise.resolve({
      modelId: 'agent:decider@2026-09',
      answers: request.questions.map((q) => ({
        id: q.id,
        type: 'boolean' as const,
        probability,
      })),
      usage: { inputTokens: 80, outputTokens: 6 },
    })
  }
  return { decide, calls, models }
}

async function run(
  args: Partial<Parameters<typeof executeDecisionAgentNode>[0]> = {},
) {
  const { decide } = stubDecider()
  const { result } = await executeDecisionAgentNode({
    node: node(),
    input: 'A customer is furious about a duplicate charge.',
    nodeOutputs: new Map(),
    getDecider: () => decide,
    manifest: manifest(),
    ...args,
  })
  return result
}

describe('an agent node pointed at a decision agent', () => {
  test('asks the AGENT’s questions', async () => {
    const { decide, calls } = stubDecider()
    await run({ getDecider: () => decide })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.questions.map((q) => q.id)).toEqual(['needs_review'])
  })

  test('resolves the decider the AGENT names', async () => {
    const asked: string[] = []
    const { decide } = stubDecider()
    await run({
      getDecider: (modelId) => {
        asked.push(modelId)
        return decide
      },
    })
    expect(asked).toEqual(['agent:decider'])
  })

  test('rolls the answers up to ONE verdict, which is why a Switch can route', async () => {
    const r = await run()
    expect(r.verdict).toBe('review')
    expect(r.because).toContain('needs_review')
    // The raw answers stay addressable alongside it.
    expect(Object.keys(r.answers)).toEqual(['needs_review'])
  })

  test('carries the echoed model id and the usage through', async () => {
    const r = await run()
    expect(r.modelId).toBe('agent:decider@2026-09')
    expect(r.usage).toEqual({ inputTokens: 80, outputTokens: 6 })
  })

  test('judges an explicit `source` ref rather than whatever arrived', async () => {
    const { decide, calls } = stubDecider()
    await run({
      node: node({ source: { kind: 'ref', nodeId: 'upstream', path: 'body' } }),
      input: 'the wrong thing',
      nodeOutputs: new Map([['upstream', { body: 'the right thing' }]]),
      getDecider: () => decide,
    })
    expect(calls[0]?.state).toBe('the right thing')
  })

  test('rehydrates a spilled subject before the agent judges it', async () => {
    const { decide, calls } = stubDecider()
    await run({
      input: { __blobRef: 'r2://big' },
      getDecider: () => decide,
      rehydrate: () => Promise.resolve('the whole document'),
    })
    expect(calls[0]?.state).toBe('the whole document')
  })

  test('binds `inputs` as the question `${variables}`', async () => {
    const { decide, calls } = stubDecider()
    const config = agentConfig()
    config.questions[0].prompt = 'Is ${tone} a problem?'
    await run({
      node: node({ inputs: { tone: { kind: 'literal', value: 'anger' } } }),
      manifest: manifest(config),
      getDecider: () => decide,
    })
    expect(calls[0]?.questions[0]?.prompt).toBe('Is anger a problem?')
  })

  test('isDecisionAgentNode tells the two agent kinds apart by the manifest', () => {
    expect(isDecisionAgentNode(node(), manifest())).toBe(true)
    expect(isDecisionAgentNode(node(), [])).toBe(false)
  })

  test('an unresolvable reference fails NAMING the agent and what to do', async () => {
    // The manifest is frozen at run start, so this is what an author sees when
    // the agent has never been published, or the workflow was not republished
    // after the node was pointed at it.
    await expect(run({ manifest: [] })).rejects.toThrow(
      /references decision agent triage, which is not in this run's manifest/,
    )
  })

  test('a generation agent’s entry is not borrowed to satisfy the reference', async () => {
    // `decisionAgentFromManifest` filters on the entry KIND, so an agent node and
    // an agent node pointing at the same id cannot pick up each other's entry.
    await expect(
      run({
        manifest: [
          {
            kind: 'agent',
            id: 'triage',
            pinnedVersion: null,
            versionId: 'v-1',
            versionNumber: 1,
            name: 'Triage',
            config: {} as never,
          },
        ],
      }),
    ).rejects.toThrow(/not in this run's manifest/)
  })
})
