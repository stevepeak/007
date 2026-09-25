import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, test } from 'bun:test'

import { defineWfConfig, type WfSdkConfig } from './config'
import { mockFinish, mockUsage } from './model-test-helpers'

// `defineWfConfig` is the one place a config is constructed, which makes it the
// one place the decision hooks can be synthesized or refused as a set. What is
// pinned here is the all-or-nothing rule and the chat-emulation toggle — the two
// ways a host turns Decision support on, and the ways it can get them wrong.

function baseConfig(): WfSdkConfig<unknown> {
  return {
    getModel: () =>
      new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: 'text' as const, text: '{"answers":[]}' }],
          finishReason: mockFinish('stop'),
          usage: mockUsage(1, 1),
          warnings: [],
        }),
      }),
    listModels: () => [
      { id: 'p:good', label: 'Good', providerId: 'p' },
      {
        id: 'p:plain',
        label: 'Plain',
        providerId: 'p',
        capabilities: { structuredOutput: false },
      },
    ],
    listProviders: () => [
      { id: 'p', label: 'Provider', kind: 'openai-compatible' as const },
    ],
    toolRegistry: new Map(),
    buildRunDeps: () => ({}),
    triggers: {},
  }
}

describe('decision hooks', () => {
  test('are all-or-nothing', () => {
    // A factory with no catalog is a node the author can't configure; a catalog
    // with no factory is a dropdown that resolves to nothing at run time. Both
    // are worse than the feature being off.
    expect(() =>
      defineWfConfig({
        ...baseConfig(),
        getDecider: () => () => Promise.resolve({ answers: [] }),
      }),
    ).toThrow('decision support needs all of')
  })

  test('are absent by default — Decision nodes are simply off', () => {
    const config = defineWfConfig(baseConfig())
    expect(config.getDecider).toBeUndefined()
    expect(config.listDecisionModels).toBeUndefined()
  })

  test('refuses the toggle alongside a real provider rather than ignoring it', () => {
    // Silently preferring `getDecider` would leave an author believing they had
    // enabled emulation and wondering why nothing says so.
    expect(() =>
      defineWfConfig({
        ...baseConfig(),
        decisionsViaChatModels: true,
        getDecider: () => () => Promise.resolve({ answers: [] }),
        listDecisionModels: () => [],
        listDecisionProviders: () => [],
      }),
    ).toThrow('a real decision provider always wins')
  })
})

describe('decisionsViaChatModels', () => {
  test('synthesizes all three hooks from the chat catalog', async () => {
    const config = defineWfConfig({
      ...baseConfig(),
      decisionsViaChatModels: true,
    })

    expect(config.getDecider).toBeDefined()
    const models = await config.listDecisionModels!({})
    const providers = await config.listDecisionProviders!({})

    // A model KNOWN to lack structured output is gated out — the adapter
    // constrains its answer with a JSON schema, and one that can't honour a
    // schema returns prose there is nothing to do with.
    expect(models.map((m) => m.id)).toEqual(['p:good'])
    // Unreported capabilities are treated as capable: we gate on a known lack,
    // never on an unknown, matching `unmetRequirements`.
    expect(models[0]).toMatchObject({ calibrated: false, providerId: 'p' })
    expect(models[0].questionTypes).toEqual(['boolean', 'category', 'scale'])
    // The badge has to say how it is serving DECISIONS, not how it serves chat.
    expect(providers[0]).toMatchObject({ id: 'p', kind: 'chat-emulated' })
  })

  test('the synthesized decider answers the contract', async () => {
    const config = defineWfConfig({
      ...baseConfig(),
      decisionsViaChatModels: true,
    })
    const decide = config.getDecider!('p:good', { triggerKind: 'test' })
    const response = await decide({
      state: 'x',
      questions: [{ id: 'q', type: 'boolean', prompt: 'Go?' }],
    })
    // The model returned no weights; the adapter reports maximum uncertainty
    // rather than dropping the question, so the answer set still matches what
    // was asked and `resolveVerdicts` has something to resolve.
    expect(response.answers).toHaveLength(1)
    expect(response.answers[0]).toMatchObject({ id: 'q', type: 'boolean' })
  })
})
