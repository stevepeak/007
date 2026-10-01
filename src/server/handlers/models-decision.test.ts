import { beforeEach, describe, expect, test } from 'bun:test'

import type { DecisionModelOption } from '../../engine/decision'
import { createWfDb, type WfDb } from '../../storage/client'
import { setModelEnabled, upsertModels } from '../../storage/data'
import { freshD1 } from '../../storage/db-test-helpers'

import { testHandlerCtx, testHandlerOptions } from './handler-test-helpers'
import { buildModelHandlers } from './models'

// `listDecisionModels` merges two sources that cannot substitute for each other:
// the host DECLARES which deciders exist and what they mean, the catalog knows
// what they currently cost and how big their window is. These tests pin which
// side wins which field, and that neither going missing takes the picker down.

/** What the host adapter declares — semantics, no live facts. */
const declared: DecisionModelOption[] = [
  {
    id: 'venice:jev-latest',
    label: 'Jev',
    providerId: 'venice',
    questionTypes: ['boolean', 'category', 'scale'],
    calibrated: true,
    contextLength: 64_000,
  },
]

function handlers(list?: () => DecisionModelOption[]) {
  return buildModelHandlers(
    testHandlerOptions({
      // `buildModelHandlers` precomputes the tool list for `getToolCatalog` at
      // build time, so an empty registry has to be present even though nothing
      // here reads it.
      config: {
        toolRegistry: new Map(),
        ...(list ? { listDecisionModels: list } : {}),
      },
    }),
  )
}

describe('listDecisionModels — host declaration ⋈ catalog facts', () => {
  let db: WfDb
  beforeEach(() => {
    db = createWfDb(freshD1())
  })

  async function catalogueJev(over: Record<string, unknown> = {}) {
    await upsertModels(db, 'venice', [
      {
        id: 'venice:jev-latest',
        modelId: 'jev-latest',
        label: 'Jev (System One)',
        providerId: 'venice',
        kind: 'decision',
        contextLength: 64_000,
        promptPricePerMTok: 0.042,
        completionPricePerMTok: 0,
        ...over,
      },
    ])
    await setModelEnabled(db, { modelId: 'venice:jev-latest', enabled: true })
  }

  test('a host with no decision provider offers nothing, catalog or not', async () => {
    await catalogueJev()
    const models = await handlers().listDecisionModels(testHandlerCtx(db, {}))
    expect(models).toEqual([])
  })

  test('before the first refresh, the host declaration passes through', async () => {
    const models = await handlers(() => declared).listDecisionModels(
      testHandlerCtx(db, {}),
    )
    expect(models).toEqual(declared)
  })

  test('the catalog supplies the label and the context window', async () => {
    await catalogueJev()
    const [jev] = await handlers(() => declared).listDecisionModels(
      testHandlerCtx(db, {}),
    )
    // Venice's own name for it, refreshed — not the adapter's shorthand.
    expect(jev?.label).toBe('Jev (System One)')
    expect(jev?.contextLength).toBe(64_000)
  })

  test('a live context window overrides the adapter floor', async () => {
    await catalogueJev({ contextLength: 128_000 })
    const [jev] = await handlers(() => declared).listDecisionModels(
      testHandlerCtx(db, {}),
    )
    expect(jev?.contextLength).toBe(128_000)
  })

  test('semantics stay the adapter’s — no catalog payload reports them', async () => {
    await catalogueJev()
    const [jev] = await handlers(() => declared).listDecisionModels(
      testHandlerCtx(db, {}),
    )
    expect(jev?.questionTypes).toEqual(['boolean', 'category', 'scale'])
    expect(jev?.calibrated).toBe(true)
  })

  test('the host list is the spine: a catalogued decider it does not declare is NOT offered', async () => {
    // `getDecider` could not resolve it, so offering it would hand the author a
    // model that fails at the first run.
    await upsertModels(db, 'venice', [
      {
        id: 'venice:ghost',
        modelId: 'ghost',
        label: 'Ghost',
        providerId: 'venice',
        kind: 'decision',
      },
    ])
    await setModelEnabled(db, { modelId: 'venice:ghost', enabled: true })
    await catalogueJev()
    const models = await handlers(() => declared).listDecisionModels(
      testHandlerCtx(db, {}),
    )
    expect(models.map((m) => m.id)).toEqual(['venice:jev-latest'])
  })

  test('a declared decider the catalog has not enabled is still offered', async () => {
    // Enablement curates the pickers, but a host that declares a decider can
    // resolve it — so the floor is the declaration, not the admin's opt-in.
    const models = await handlers(() => declared).listDecisionModels(
      testHandlerCtx(db, {}),
    )
    expect(models.map((m) => m.id)).toEqual(['venice:jev-latest'])
  })
})
