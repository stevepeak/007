import type { ModelProvider, WfSdkConfig } from '../engine/config'
import { errorMessage } from '../engine/error-message'
import { resolveWfLogger } from '../engine/logger'
import type { WfDb } from '../storage/client'
import {
  invalidateModelPriceMap,
  listConnectors,
  recordChange,
  touchModelProvider,
  upsertModels,
  WORKSPACE_OWNER,
} from '../storage/data'

import { refreshConnectorCatalog } from './connector-connections'
import type { ConnectorRefreshResult } from './protocol-connectors'

type CatalogRefreshConfig<TDeps> = Pick<
  WfSdkConfig<TDeps>,
  'listProviders' | 'fetchModelCatalog' | 'resolveConnectorSecret' | 'logger'
>

/**
 * Re-read one provider's `/models` and cache it. Newly discovered models are
 * inserted DISABLED and existing rows keep their `enabled` flag (see
 * `upsertModels`), so a refresh never changes what an agent runs on.
 */
export async function refreshProviderModels<TDeps>(args: {
  config: Pick<WfSdkConfig<TDeps>, 'listProviders' | 'fetchModelCatalog'>
  db: WfDb
  env: unknown
  providerId: string
  /** Pass the already-listed provider to skip a second `listProviders` call. */
  provider?: ModelProvider
}): Promise<{ count: number; refreshedAt: number }> {
  const { config, db, env, providerId } = args
  const fetchCatalog = config.fetchModelCatalog
  if (!fetchCatalog) {
    throw new Error(
      'This host does not support refreshing models (no `fetchModelCatalog` configured).',
    )
  }
  const entries = await fetchCatalog({ env }, providerId)
  const count = await upsertModels(db, providerId, entries)
  // Prices just moved — drop the memo so run costs re-derive off the new
  // catalog now rather than after the TTL.
  invalidateModelPriceMap(db)
  const refreshedAt = new Date()
  const provider = args.provider ??
    (await config.listProviders({ env })).find((p) => p.id === providerId) ?? {
      id: providerId,
      label: providerId,
      kind: 'custom' as const,
    }
  await touchModelProvider(db, provider, refreshedAt)
  return { count, refreshedAt: refreshedAt.getTime() }
}

/** One catalog's outcome in a {@link refreshAllCatalogs} pass. */
export type CatalogRefreshOutcome<T> =
  | ({ id: string; ok: true } & T)
  | { id: string; ok: false; error: string }

export type CatalogRefreshReport = {
  models: CatalogRefreshOutcome<{ count: number }>[]
  connectors: CatalogRefreshOutcome<ConnectorRefreshResult>[]
}

/**
 * Refresh every model provider's catalog and every enabled connector's tool
 * catalog — the scheduled counterpart of the two Refresh buttons. Call it from
 * the host's cron (see the guide's "Scheduled catalog refresh").
 *
 * Each catalog is isolated: one unreachable provider or server is reported in
 * the result and logged, and never costs the others their turn. Nothing is
 * auto-enabled, exactly as with a manual refresh.
 *
 * Connectors are read with the workspace credential. A connector that only
 * per-owner connections can reach reports `ok: false` here.
 * TODO: fall back to any connected owner's credential.
 */
export async function refreshAllCatalogs<TDeps>(args: {
  config: CatalogRefreshConfig<TDeps>
  db: WfDb
  /** Host bindings, handed to `fetchModelCatalog` / `resolveConnectorSecret`. */
  env: unknown
}): Promise<CatalogRefreshReport> {
  const { config, db, env } = args
  const logger = resolveWfLogger(config.logger)
  const report: CatalogRefreshReport = { models: [], connectors: [] }

  if (config.fetchModelCatalog) {
    for (const provider of await config.listProviders({ env })) {
      try {
        const { count } = await refreshProviderModels({
          config,
          db,
          env,
          providerId: provider.id,
          provider,
        })
        report.models.push({ id: provider.id, ok: true, count })
      } catch (err) {
        logger.error(`[wf] catalog refresh: models ${provider.id} failed`, err)
        report.models.push({
          id: provider.id,
          ok: false,
          error: errorMessage(err),
        })
      }
    }
  }

  // Without the key no stored credential can be read, so there is nothing a
  // connector refresh could authenticate with.
  const secret = config.resolveConnectorSecret?.({ env })
  if (!secret) return report

  for (const connector of await listConnectors(db)) {
    if (!connector.enabled) continue
    try {
      const { label, ...result } = await refreshConnectorCatalog({
        db,
        secret,
        connectorId: connector.id,
        owner: WORKSPACE_OWNER,
      })
      const changed =
        result.added + result.updated + result.missing + result.drifted.length
      // Only a pass that moved something reaches the activity feed — an
      // unchanged catalog every few hours would bury every human edit.
      if (changed > 0) {
        await recordChange(
          db,
          {
            entityKind: 'connector',
            entityId: connector.id,
            action: 'update',
            note:
              `Refreshed ${label}: ${result.added} new, ` +
              `${result.updated} updated, ${result.missing} withdrawn` +
              (result.drifted.length > 0
                ? `, ${result.drifted.length} schema change(s)`
                : ''),
            actor: { userId: null, source: 'system' },
          },
          logger,
        )
      }
      report.connectors.push({ id: connector.id, ok: true, ...result })
    } catch (err) {
      logger.error(
        `[wf] catalog refresh: connector ${connector.id} failed`,
        err,
      )
      report.connectors.push({
        id: connector.id,
        ok: false,
        error: errorMessage(err),
      })
    }
  }
  return report
}
