import { afterEach, describe, expect, spyOn, test } from 'bun:test'

import type { ModelCatalogEntry, ModelProvider } from '../engine/config'
import { createWfDb } from '../storage/client'
import {
  getConnector,
  getModelCatalog,
  listChanges,
  listModelProviders,
  upsertConnector,
} from '../storage/data'
import { freshD1 } from '../storage/db-test-helpers'

import { refreshAllCatalogs } from './catalog-refresh'

const providers: ModelProvider[] = [
  { id: 'alpha', label: 'Alpha', kind: 'custom' },
  { id: 'beta', label: 'Beta', kind: 'custom' },
]

function entry(providerId: string): Omit<ModelCatalogEntry, 'enabled'> {
  return {
    id: `${providerId}:m1`,
    modelId: 'm1',
    label: 'Model One',
    providerId,
  }
}

// `upsertModels` batches, which only the D1-shaped handle supports.
const freshDb = () => createWfDb(freshD1())

const silent = { error: () => {}, warn: () => {}, info: () => {} }

afterEach(() => {
  spyOn(globalThis, 'fetch').mockRestore()
})

describe('refreshAllCatalogs', () => {
  test('refreshes every provider, isolating one that fails', async () => {
    const db = freshDb()
    const report = await refreshAllCatalogs({
      db,
      env: {},
      config: {
        logger: silent,
        listProviders: () => providers,
        fetchModelCatalog: async (_ctx, providerId) => {
          if (providerId === 'alpha') throw new Error('alpha is down')
          return [entry(providerId)]
        },
      },
    })

    expect(report.models).toEqual([
      { id: 'alpha', ok: false, error: 'alpha is down' },
      { id: 'beta', ok: true, count: 1 },
    ])
    const catalog = await getModelCatalog(db)
    // Discovered, and still disabled: a refresh never opts a model in.
    expect(catalog.models.map((m) => [m.id, m.enabled])).toEqual([
      ['beta:m1', false],
    ])
    const touched = await listModelProviders(db)
    expect(touched.map((p) => p.id)).toEqual(['beta'])
  })

  test('skips models when the host has no fetchModelCatalog', async () => {
    const report = await refreshAllCatalogs({
      db: freshDb(),
      env: {},
      config: { logger: silent, listProviders: () => providers },
    })
    expect(report).toEqual({ models: [], connectors: [] })
  })

  test('skips disabled connectors and reports an unreachable one', async () => {
    const db = freshDb()
    await upsertConnector(db, {
      id: 'off',
      label: 'Off',
      url: 'https://off.example.com',
      authKind: 'none',
      enabled: false,
    })
    await upsertConnector(db, {
      id: 'down',
      label: 'Down',
      url: 'https://down.example.com',
      authKind: 'none',
    })
    spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('connection refused'),
    )

    const report = await refreshAllCatalogs({
      db,
      env: {},
      config: {
        logger: silent,
        listProviders: () => [],
        resolveConnectorSecret: () => 'test-key-do-not-use-in-prod',
      },
    })

    expect(report.connectors.map((c) => [c.id, c.ok])).toEqual([
      ['down', false],
    ])
    // A failed pass leaves no trace of a refresh that did not happen.
    expect((await getConnector(db, 'down'))?.lastRefreshedAt).toBeNull()
    expect(await listChanges(db, {})).toHaveLength(0)
  })

  test('leaves connectors alone without the encryption key', async () => {
    const db = freshDb()
    await upsertConnector(db, {
      id: 'acme',
      label: 'Acme',
      url: 'https://mcp.example.com',
      authKind: 'none',
    })
    const fetchSpy = spyOn(globalThis, 'fetch')
    const report = await refreshAllCatalogs({
      db,
      env: {},
      config: { logger: silent, listProviders: () => [] },
    })
    expect(report.connectors).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
