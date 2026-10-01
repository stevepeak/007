import { beforeEach, describe, expect, test } from 'bun:test'

import type { ModelCatalogEntry } from '../../engine/config'
import { createWfDb, type WfDb } from '../client'
import { freshD1 } from '../db-test-helpers'

import {
  getModelCatalog,
  listEnabledDecisionModelFacts,
  listEnabledModels,
  setModelEnabled,
  upsertModels,
} from './models'

// The two catalogs share one table and are separated ONLY by `wf_model.kind`.
// Everything here is about that seam: a decision model must reach the decision
// pickers and must never reach the chat ones, in both directions, and the
// separation has to survive the refresh upsert that preserves `enabled`.

type Entry = Omit<ModelCatalogEntry, 'enabled'>

function chat(id: string): Entry {
  return {
    id: `venice:${id}`,
    modelId: id,
    label: id,
    providerId: 'venice',
    promptPricePerMTok: 1,
    completionPricePerMTok: 2,
  }
}

function decision(id: string): Entry {
  return {
    ...chat(id),
    kind: 'decision',
    label: 'Jev (System One)',
    contextLength: 64_000,
    promptPricePerMTok: 0.042,
    completionPricePerMTok: 0,
  }
}

describe('wf_model.kind — two catalogs, one table', () => {
  let db: WfDb
  beforeEach(async () => {
    // `createWfDb` over a D1-shaped facade, not `freshDb`: `upsertModels` chunks
    // its refresh into `db.batch`, which the bare bun:sqlite wrapper has no
    // method for.
    db = createWfDb(freshD1())
    await upsertModels(db, 'venice', [chat('qwen3-5-9b'), decision('jev-latest')])
    // A refresh inserts everything disabled; the admin opts in.
    await setModelEnabled(db, { modelId: 'venice:qwen3-5-9b', enabled: true })
    await setModelEnabled(db, { modelId: 'venice:jev-latest', enabled: true })
  })

  test('a decision model never reaches the chat pickers', async () => {
    const models = await listEnabledModels(db)
    expect(models.map((m) => m.id)).toEqual(['venice:qwen3-5-9b'])
  })

  test('a chat model never reaches the decision pickers', async () => {
    const facts = await listEnabledDecisionModelFacts(db)
    expect(facts.map((f) => f.id)).toEqual(['venice:jev-latest'])
  })

  test('the decision facts carry what the catalog knows and nothing it invents', async () => {
    const [jev] = await listEnabledDecisionModelFacts(db)
    expect(jev).toEqual({
      id: 'venice:jev-latest',
      label: 'Jev (System One)',
      providerId: 'venice',
      contextLength: 64_000,
    })
  })

  test('a model the admin has not enabled is in neither picker', async () => {
    await upsertModels(db, 'venice', [decision('jev-next')])
    const facts = await listEnabledDecisionModelFacts(db)
    expect(facts.map((f) => f.id)).toEqual(['venice:jev-latest'])
    // …but the admin page still sees it, which is how it gets enabled.
    const { models } = await getModelCatalog(db)
    expect(models.find((m) => m.id === 'venice:jev-next')?.kind).toBe('decision')
  })

  test('the admin catalog reports every row with its kind', async () => {
    const { models } = await getModelCatalog(db)
    expect(
      Object.fromEntries(models.map((m) => [m.modelId, m.kind])),
    ).toEqual({ 'qwen3-5-9b': 'chat', 'jev-latest': 'decision' })
  })

  test('an entry with no kind is a chat model — the pre-split default', async () => {
    await upsertModels(db, 'venice', [chat('legacy-model')])
    await setModelEnabled(db, { modelId: 'venice:legacy-model', enabled: true })
    // `ModelOption` carries the composite `id`, not the native `modelId`.
    const models = await listEnabledModels(db)
    expect(models.map((m) => m.id).sort()).toEqual([
      'venice:legacy-model',
      'venice:qwen3-5-9b',
    ])
  })

  test('a refresh re-reads the kind rather than freezing first impressions', async () => {
    // Same id, now reported as a decision model. It has to MOVE catalogs, or it
    // would be offered in the chat picker forever on the strength of how it was
    // first seen.
    await upsertModels(db, 'venice', [decision('qwen3-5-9b')])
    expect((await listEnabledModels(db)).map((m) => m.id)).toEqual([])
    // Sorted: both rows now carry the same label, so the catalog's
    // `vendor, label` ordering has nothing left to break the tie with.
    expect(
      (await listEnabledDecisionModelFacts(db)).map((f) => f.id).sort(),
    ).toEqual(['venice:jev-latest', 'venice:qwen3-5-9b'])
  })

  test('a refresh preserves the enabled flag across the kinds', async () => {
    await upsertModels(db, 'venice', [decision('jev-latest')])
    expect((await listEnabledDecisionModelFacts(db)).map((f) => f.id)).toEqual([
      'venice:jev-latest',
    ])
  })
})
