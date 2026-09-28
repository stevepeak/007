import { beforeEach, describe, expect, test } from 'bun:test'

import type { AgentConfig } from '../../engine/graph'
import type { WfDb } from '../../storage/client'
import {
  createAgent,
  listAgentVersions,
  listChanges,
} from '../../storage/data'
import { freshDb } from '../../storage/db-test-helpers'

import { buildAgentHandlers } from './agents'
import { buildChangeHandlers } from './changes'
import { testHandlerCtx, testHandlerOptions } from './handler-test-helpers'
import type { CreateWfSdkHandlersOptions } from './shared'

// The publish path end-to-end through the handler: the AI summary riding along
// with the publish, the background fill when it didn't, and the restore read.
// Everything below the handler is real (a migrated in-memory D1); only the model
// seam and the host's scheduler are stubbed.

function config(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    modelId: 'test-model',
    prompt: 'You are a costing assistant.',
    userPrompt: 'Cost this dish: ${dish}',
    toolIds: [],
    maxTurns: 5,
    inputKind: 'task',
    output: { kind: 'text' },
    subAgents: {
      targets: [],
      maxConcurrent: 4,
      maxSpawns: 10,
      allowStopSignal: true,
    },
    ...over,
  } as AgentConfig
}

// Deferred work the host would hand to `ctx.waitUntil`, collected so the test
// can await it deterministically instead of racing it.
let pending: Promise<unknown>[] = []

function options(
  over: Parameters<typeof testHandlerOptions>[0] = {},
): CreateWfSdkHandlersOptions<unknown> {
  return testHandlerOptions({
    // No model on offer → computeAgentChangeSummary falls to the heuristic,
    // which is what keeps this test free of any network call.
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p)
    },
    ...over,
  })
}

describe('agent publish handler', () => {
  let db: WfDb
  let agentId: string

  beforeEach(async () => {
    pending = []
    db = freshDb()
    const created = await createAgent(db, { name: 'Coster', config: config() })
    agentId = created.agentId
  })

  test("a summary supplied by the dialog is stored and no background work is queued", async () => {
    const handlers = buildAgentHandlers(options())
    await handlers.publishAgent(
      testHandlerCtx(db, {
        agentId,
        config: config({ maxTurns: 9 }),
        changeNote: 'more turns',
        aiSummary: { short: 'Raise the turn limit', long: '- 5 → 9' },
      }),
    )

    expect(pending).toHaveLength(0)
    const [latest] = await listAgentVersions(db, agentId)
    expect(latest.versionNumber).toBe(2)
    expect(latest.changeNote).toBe('more turns')
    expect(latest.aiSummaryShort).toBe('Raise the turn limit')
    expect(latest.aiSummaryLong).toBe('- 5 → 9')
  })

  // The change log has to be written by the HANDLER, not just by `recordChange`
  // — nothing in the type system forces the call, so it needs a test that would
  // notice it going missing.
  test('a publish is recorded in the change log, with its actor and diff', async () => {
    const handlers = buildAgentHandlers(options())
    await handlers.publishAgent(
      testHandlerCtx(db, {
        agentId,
        config: config({ modelId: 'other-model', maxTurns: 9 }),
        changeNote: 'swap the model',
        aiSummary: { short: 's', long: 'l' },
      }),
    )

    const [change] = await listChanges(db, {
      entityKind: 'agent',
      entityId: agentId,
    })
    expect(change.action).toBe('publish')
    expect(change.actorId).toBe('tester')
    // Named the way the editor names them — the shared label table.
    expect(change.fields).toEqual(['model', 'max turns'])
    expect(change.note).toBe('swap the model')
    // The config itself is already immutable in wf_agent_version; the log points
    // at it rather than storing a second copy.
    expect(change.after).toMatchObject({ versionNumber: 2 })
  })

  test('an agent rename is recorded, since metadata has no version history', async () => {
    const handlers = buildAgentHandlers(options())
    await handlers.updateAgentMeta(testHandlerCtx(db, { agentId, name: 'Renamed' }))

    const [change] = await listChanges(db, {
      entityKind: 'agent',
      entityId: agentId,
    })
    expect(change.action).toBe('update')
    expect(change.fields).toEqual(['name'])
    expect(change.before).toMatchObject({ name: 'Coster' })
    expect(change.after).toMatchObject({ name: 'Renamed' })
  })

  // The read path, through the same handler the UI calls — the Activity view is
  // only as good as this returning what the mutation wrote.
  test('the change feed serves what the handlers recorded', async () => {
    const handlers = buildAgentHandlers(options())
    await handlers.updateAgentMeta(testHandlerCtx(db, { agentId, name: 'Renamed' }))
    await handlers.publishAgent(
      testHandlerCtx(db, {
        agentId,
        config: config({ modelId: 'other-model' }),
        aiSummary: { short: 's', long: 'l' },
      }),
    )

    const feed = buildChangeHandlers()
    const rows = await feed.listChanges(
      testHandlerCtx(db, { entityKind: 'agent', entityId: agentId }),
    )
    // Newest first.
    expect(rows.map((r) => r.action)).toEqual(['publish', 'update'])
    expect(rows[0].fields).toEqual(['model'])
    expect(rows[0].actorId).toBe('tester')
    expect(rows[0].createdAt).toBeGreaterThan(0)
  })

  test('the feed does not leak another entity\'s history', async () => {
    const handlers = buildAgentHandlers(options())
    await handlers.updateAgentMeta(testHandlerCtx(db, { agentId, name: 'Renamed' }))

    const feed = buildChangeHandlers()
    const rows = await feed.listChanges(
      testHandlerCtx(db, { entityKind: 'agent', entityId: 'some-other-agent' }),
    )
    expect(rows).toEqual([])
  })

  test('publishing without a summary fills it in the background', async () => {
    const handlers = buildAgentHandlers(options())
    await handlers.publishAgent(
      testHandlerCtx(db, { agentId, config: config({ modelId: 'other-model' }) }),
    )

    // Before the deferred work runs, the row is published but unsummarized —
    // this is the state the UI polls on.
    const [beforeFill] = await listAgentVersions(db, agentId)
    expect(beforeFill.versionNumber).toBe(2)
    expect(beforeFill.aiSummaryShort).toBeNull()

    expect(pending).toHaveLength(1)
    await Promise.all(pending)

    const [afterFill] = await listAgentVersions(db, agentId)
    // The diff is against v1, captured before the publish moved the head.
    expect(afterFill.aiSummaryShort).toBe('Changed the model.')
  })

  test('no scheduler wired means no background fill, and the publish still succeeds', async () => {
    const handlers = buildAgentHandlers(options({ waitUntil: undefined }))
    const out = await handlers.publishAgent(
      testHandlerCtx(db, { agentId, config: config({ maxTurns: 3 }) }),
    )

    expect((out as { versionNumber: number }).versionNumber).toBe(2)
    expect(pending).toHaveLength(0)
    expect((await listAgentVersions(db, agentId))[0].aiSummaryShort).toBeNull()
  })

  test('a host override wins over the built-in summarizer', async () => {
    const handlers = buildAgentHandlers(
      options({
        summarizeAgentChanges: async () => ({
          short: 'From the host',
          long: '',
        }),
      }),
    )
    const summary = await handlers.summarizeAgentChanges(
      testHandlerCtx(db, { agentId, config: config({ maxTurns: 7 }) }),
    )
    expect(summary).toEqual({ short: 'From the host', long: '' })
  })

  test('summarizeAgentChanges diffs against the published head without publishing', async () => {
    const handlers = buildAgentHandlers(options())
    const summary = await handlers.summarizeAgentChanges(
      testHandlerCtx(db, { agentId, config: config({ toolIds: ['search_catalog'] }) }),
    )
    expect(summary).toEqual({ short: 'Added 1 tool.', long: '' })
    // Still just the seeded version — summarizing is not publishing.
    expect(await listAgentVersions(db, agentId)).toHaveLength(1)
  })

  test('getAgentVersion returns a historical config, and null for an unknown id', async () => {
    const handlers = buildAgentHandlers(options())
    const [v1] = await listAgentVersions(db, agentId)
    await handlers.publishAgent(
      testHandlerCtx(db, { agentId, config: config({ prompt: 'Totally different.' }) }),
    )

    const restored = (await handlers.getAgentVersion(
      testHandlerCtx(db, { versionId: v1.id }),
    )) as { config: AgentConfig; versionNumber: number }
    expect(restored.versionNumber).toBe(1)
    expect(restored.config.prompt).toBe('You are a costing assistant.')

    expect(await handlers.getAgentVersion(testHandlerCtx(db, { versionId: 'nope' }))).toBeNull()
  })
})
