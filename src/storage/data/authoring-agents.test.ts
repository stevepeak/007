import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, test } from 'bun:test'

import type { AgentConfig } from '../../engine/graph'
import type { WfDb } from '../client'
import { wfAgentDraft, wfSchema } from '../schema'

import {
  createAgent,
  discardAgentDraft,
  getAgent,
  getAgentVersionConfig,
  listAgentVersions,
  publishAgent,
  setAgentVersionAiSummary,
  updateAgentDraft,
} from './authoring-agents'

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../migrations', import.meta.url),
)

function freshDb(): WfDb {
  const sqlite = new Database(':memory:')
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const f of files) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${f}`, 'utf8')
    for (const stmt of sql.split('--> statement-breakpoint')) {
      const trimmed = stmt.trim()
      if (trimmed) sqlite.run(trimmed)
    }
  }
  return drizzle(sqlite, { schema: wfSchema }) as unknown as WfDb
}

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

describe('agent version history', () => {
  let db: WfDb

  beforeEach(() => {
    db = freshDb()
  })

  async function seedAgent() {
    const { agentId } = await createAgent(db, {
      name: 'Coster',
      config: config(),
    })
    return agentId
  }

  test('publishing with an AI summary persists it onto the version row', async () => {
    const agentId = await seedAgent()
    const { versionId } = await publishAgent(db, {
      agentId,
      config: config({ modelId: 'other-model' }),
      changeNote: 'swap the model',
      aiSummaryShort: 'Swap the model',
      aiSummaryLong: '- other-model instead of test-model',
    })

    const versions = await listAgentVersions(db, agentId)
    const published = versions.find((v) => v.id === versionId)
    expect(published?.versionNumber).toBe(2)
    expect(published?.changeNote).toBe('swap the model')
    expect(published?.aiSummaryShort).toBe('Swap the model')
    expect(published?.aiSummaryLong).toBe('- other-model instead of test-model')
  })

  test('a publish without a summary leaves it null for the background fill', async () => {
    const agentId = await seedAgent()
    const { versionId } = await publishAgent(db, {
      agentId,
      config: config({ maxTurns: 9 }),
    })

    const before = await listAgentVersions(db, agentId)
    expect(before.find((v) => v.id === versionId)?.aiSummaryShort).toBeNull()

    await setAgentVersionAiSummary(db, {
      versionId,
      short: 'Raise the turn limit',
      long: '',
    })

    const after = await listAgentVersions(db, agentId)
    const filled = after.find((v) => v.id === versionId)
    expect(filled?.aiSummaryShort).toBe('Raise the turn limit')
    // Filling the summary must not disturb anything else on the row.
    expect(filled?.versionNumber).toBe(2)
  })

  test('version numbers increment and the draft re-points at the new version', async () => {
    const agentId = await seedAgent()
    const second = await publishAgent(db, { agentId, config: config() })
    const third = await publishAgent(db, { agentId, config: config() })

    expect(second.versionNumber).toBe(2)
    expect(third.versionNumber).toBe(3)

    const versions = await listAgentVersions(db, agentId)
    // Newest first — the order the history dropdown renders.
    expect(versions.map((v) => v.versionNumber)).toEqual([3, 2, 1])

    const draft = (
      await db
        .select()
        .from(wfAgentDraft)
        .where(eq(wfAgentDraft.agentId, agentId))
        .limit(1)
    )[0]
    expect(draft?.baseVersionId).toBe(third.versionId)
  })

  test('getAgentVersionConfig round-trips a historical config', async () => {
    const agentId = await seedAgent()
    const v1 = (await listAgentVersions(db, agentId))[0]
    await publishAgent(db, {
      agentId,
      config: config({ prompt: 'Totally different.', maxTurns: 12 }),
    })

    const restored = await getAgentVersionConfig(db, v1.id)
    expect(restored?.versionNumber).toBe(1)
    expect(restored?.agentId).toBe(agentId)
    expect(restored?.config.prompt).toBe('You are a costing assistant.')
    expect(restored?.config.maxTurns).toBe(5)
  })

  test('getAgentVersionConfig is null for an unknown version', async () => {
    expect(await getAgentVersionConfig(db, 'nope')).toBeNull()
  })

  test('loading a version does not publish — the live version is unchanged', async () => {
    const agentId = await seedAgent()
    await publishAgent(db, {
      agentId,
      config: config({ prompt: 'v2 prompt' }),
    })

    // What the editor's "load an old version" does: read it, then park it in the
    // draft. The published head must not move.
    const v1 = (await listAgentVersions(db, agentId)).find(
      (v) => v.versionNumber === 1,
    )!
    const old = await getAgentVersionConfig(db, v1.id)
    await updateAgentDraft(db, { agentId, config: old!.config })

    const loaded = await getAgent(db, agentId)
    expect(loaded?.currentVersion?.versionNumber).toBe(2)
    expect(
      (loaded?.currentVersion?.config as AgentConfig | undefined)?.prompt,
    ).toBe('v2 prompt')
    expect((loaded?.draft?.config as AgentConfig | undefined)?.prompt).toBe(
      'You are a costing assistant.',
    )
    expect(await listAgentVersions(db, agentId)).toHaveLength(2)

    // And discarding puts the draft back on the published head.
    await discardAgentDraft(db, { agentId })
    const reset = await getAgent(db, agentId)
    expect((reset?.draft?.config as AgentConfig | undefined)?.prompt).toBe(
      'v2 prompt',
    )
  })
})
