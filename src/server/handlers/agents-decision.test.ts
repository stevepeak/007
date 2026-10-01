import { beforeEach, describe, expect, test } from 'bun:test'

import { makeAgentConfig } from '../../engine/agent-test-helpers'
import type { Decider } from '../../engine/decision'
import {
  starterDecisionAgentConfig,
  type DecisionAgentConfig,
} from '../../engine/decision-agent-schema'
import type { WfDb } from '../../storage/client'
import { freshDb } from '../../storage/db-test-helpers'
import type { WfAgentDetail } from '../protocol'

import { buildAgentHandlers } from './agents'
import { testHandlerCtx, testHandlerOptions } from './handler-test-helpers'

// The agent handlers, once `wf_agent.kind` exists: the kind is fixed at
// creation and never again, every later write is validated against the shape
// it names, and the decision playground runs without a host hook.

function workingConfig(): DecisionAgentConfig {
  const starter = starterDecisionAgentConfig('venice:jev-latest')
  return {
    ...starter,
    questions: starter.questions.map((q) => ({
      ...q,
      prompt: 'Does this need a person to look at it before we act?',
    })),
  }
}

/** A decider that says yes, and echoes a DIFFERENT model id than it was asked. */
const yesDecider: Decider = async () => ({
  modelId: 'venice:jev-2026-01',
  answers: [{ id: 'needs_review', type: 'boolean', probability: 0.91 }],
  usage: { inputTokens: 40, outputTokens: 5 },
})

describe('agent handlers — kind', () => {
  let db: WfDb
  beforeEach(() => {
    db = freshDb()
  })

  const handlers = (over: Parameters<typeof testHandlerOptions>[0] = {}) => {
    return buildAgentHandlers(testHandlerOptions(over))
  }

  async function createDecisionAgent(over: Partial<DecisionAgentConfig> = {}) {
    const h = handlers()
    return await h.createAgent(
      testHandlerCtx(db, {
        name: 'Triage',
        kind: 'decision',
        config: { ...workingConfig(), ...over },
      }),
    )
  }

  test('an agent created with no kind is a generation agent', async () => {
    const h = handlers()
    const { agentId } = await h.createAgent(
      testHandlerCtx(db, {
        name: 'Greeter',
        config: makeAgentConfig({ modelId: 'm', prompt: 'Hi.' }),
      }),
    )
    const detail = (await h.getAgent(
      testHandlerCtx(db, { agentId }),
    )) as WfAgentDetail
    expect(detail.agent.kind).toBe('generation')
  })

  test('a decision agent stores its own config shape and summarises the matrix', async () => {
    const { agentId } = await createDecisionAgent()
    const detail = (await handlers().getAgent(
      testHandlerCtx(db, { agentId }),
    )) as WfAgentDetail
    expect(detail.agent.kind).toBe('decision')
    expect(detail.agent.decision).toEqual({
      questionCount: 1,
      questionIds: ['needs_review'],
      verdicts: ['review', 'proceed'],
      inputVariables: [],
    })
    // The fields that only mean something for a generation agent stay empty
    // rather than being filled with plausible-looking defaults.
    expect(detail.agent.toolIds).toEqual([])
    expect(detail.agent.output).toBeNull()
    expect(detail.agent.modelRequirements).toBeNull()
    // …except the model, which both shapes have and a card has to show.
    expect(detail.agent.modelId).toBe('venice:jev-latest')
  })

  test('the listing carries the kind, so every picker can filter on it', async () => {
    await createDecisionAgent()
    const rows = (await handlers().listAgents(
      testHandlerCtx(db, {}),
    ))
    expect(rows.map((r) => r.kind)).toEqual(['decision'])
  })

  test('a draft is validated against the shape the AGENT declares, not the payload', async () => {
    const { agentId } = await createDecisionAgent()
    // A generation config is not a decision config with holes — it is the
    // wrong config, and this is where that becomes an error rather than a row
    // nothing can read back.
    await expect(
      handlers().updateAgentDraft(
        testHandlerCtx(db, {
          agentId,
          config: makeAgentConfig({ modelId: 'm', prompt: 'Hi.' }),
        }),
      ),
    ).rejects.toThrow()
  })

  test('publishing a decision agent keeps its config readable back', async () => {
    const { agentId } = await createDecisionAgent()
    const next: DecisionAgentConfig = {
      ...workingConfig(),
      verdicts: ['review', 'proceed', 'escalate'],
    }
    await handlers().publishAgent(testHandlerCtx(db, { agentId, config: next }))
    const detail = (await handlers().getAgent(
      testHandlerCtx(db, { agentId }),
    )) as WfAgentDetail
    expect(detail.currentVersion?.versionNumber).toBe(2)
    expect(detail.agent.decision?.verdicts).toEqual([
      'review',
      'proceed',
      'escalate',
    ])
  })

  test('a version read back says which shape it is', async () => {
    const { agentId, versionId } = await createDecisionAgent()
    expect(agentId).toBeTruthy()
    const version = await handlers().getAgentVersion(
      testHandlerCtx(db, { versionId }),
    )
    expect(version?.kind).toBe('decision')
  })

  test('an AI change summary is refused rather than described from the wrong fields', async () => {
    const { agentId } = await createDecisionAgent()
    await expect(
      handlers().summarizeAgentChanges(
        testHandlerCtx(db, { agentId, config: workingConfig() }),
      ),
    ).rejects.toThrow(/generation agents/)
  })
})

describe('runDecisionPreview', () => {
  let db: WfDb
  beforeEach(() => {
    db = freshDb()
  })

  test('judges the draft through getDecider and echoes what ANSWERED', async () => {
    const h = buildAgentHandlers(
      testHandlerOptions({ config: { getDecider: () => yesDecider } }),
    )
    const result = await h.runDecisionPreview(
      testHandlerCtx(db, {
        config: workingConfig(),
        state: 'Customer is furious about a duplicate charge.',
      }),
    )
    expect(result.verdict).toBe('review')
    expect(result.because).toContain('needs_review 0.91')
    // Not the id we asked with: `jev-latest` floats, and the record has to
    // carry what actually answered.
    expect(result.modelId).toBe('venice:jev-2026-01')
  })

  test('a host with no decision provider refuses clearly rather than crashing', async () => {
    const h = buildAgentHandlers(testHandlerOptions())
    await expect(
      h.runDecisionPreview(
        testHandlerCtx(db, { config: workingConfig(), state: 'x' }),
      ),
    ).rejects.toThrow(/no decision provider/i)
  })
})
