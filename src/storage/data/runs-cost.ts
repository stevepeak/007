import type { WfDb } from '../client'
import type { ModelPrice, ModelPriceMap } from '../cost'
import { wfModel } from '../schema'

import { foldUsage, groupUsageByRun, selectRunUsage } from './runs-usage'

// ---------------------------------------------------------------------------
// Cost derivation — model price map + per-run token/cost/timing stats
// ---------------------------------------------------------------------------

/**
 * How long a loaded price map stays warm. `wf_model` only changes when an admin
 * refreshes a provider catalog or toggles a model, so a minute of staleness on
 * a *displayed dollar figure* is immaterial — while the read itself sits behind
 * every run-viewer tick, eval poll, and runs-list page.
 */
const PRICE_MAP_TTL_MS = 60_000

/**
 * Cache the SETTLED value, never the in-flight promise: workerd throws
 * "Cannot perform I/O on behalf of a different request" when a later request
 * awaits a promise created in an earlier request's I/O context. A concurrent
 * miss therefore just runs the query twice, which is cheap and rare.
 *
 * Keyed by the underlying driver (`$client` — the D1 binding in a Worker, the
 * sqlite handle under a test) rather than the drizzle wrapper, because
 * `createWfDb` mints a fresh wrapper per request and keying on that would never
 * hit. Keying on the driver also means two handles onto *different* databases
 * can never share an entry: a process that talks to several databases (the
 * `createWfDbHttp` CLI, a test file building its own in-memory DB) is correct
 * by construction instead of by convention.
 */
const priceMapCache = new WeakMap<object, { at: number; map: ModelPriceMap }>()

/** The driver behind a handle, or null when it can't be identified (in which
 *  case we simply don't cache). */
function priceMapKey(db: WfDb): object | null {
  const client = (db as unknown as { $client?: unknown }).$client
  return typeof client === 'object' && client !== null ? client : null
}

/**
 * Drop the memo after a catalog write, so an admin who refreshes models sees
 * new prices immediately instead of up to {@link PRICE_MAP_TTL_MS} later.
 * Clears THIS isolate only — others converge within the TTL.
 */
export function invalidateModelPriceMap(db: WfDb): void {
  const key = priceMapKey(db)
  if (key) priceMapCache.delete(key)
}

/**
 * Every catalogued model's price, keyed for cost derivation. A run step records
 * `meta.model` as the provider-native id (`wf_model.modelId`); we key by that AND
 * the composite `id` so either resolves. Shared by the runs list (aggregate) and
 * the run inspector (per node).
 *
 * The underlying read is a full `wf_model` scan — `refreshModels` upserts a
 * provider's entire catalog (300+ rows) and never prunes — so it is memoized for
 * {@link PRICE_MAP_TTL_MS}. The returned map is SHARED across requests and must
 * be treated read-only; every consumer only ever `.get()`s from it.
 */
export async function loadModelPriceMap(db: WfDb): Promise<ModelPriceMap> {
  const key = priceMapKey(db)
  const hit = key ? priceMapCache.get(key) : undefined
  if (hit && Date.now() - hit.at < PRICE_MAP_TTL_MS) return hit.map
  const rows = await db
    .select({
      id: wfModel.id,
      modelId: wfModel.modelId,
      costPerMTok: wfModel.costPerMTok,
      promptPricePerMTok: wfModel.promptPricePerMTok,
      completionPricePerMTok: wfModel.completionPricePerMTok,
    })
    .from(wfModel)
  const map: ModelPriceMap = new Map()
  for (const r of rows) {
    const price: ModelPrice = {
      promptPerMTok: r.promptPricePerMTok,
      completionPerMTok: r.completionPricePerMTok,
      blendedPerMTok: r.costPerMTok,
    }
    map.set(r.modelId, price)
    // Don't let a composite-id entry clobber a bare-id match (what steps record).
    if (!map.has(r.id)) map.set(r.id, price)
  }
  if (key) priceMapCache.set(key, { at: Date.now(), map })
  return map
}

/**
 * A price table flattened for the workflow journal: `[modelKey, prompt,
 * completion, blended]` per row, USD per 1M tokens.
 *
 * A `Map` can't cross a `step.do` boundary, and the journal is replayed on
 * every wake, so the shape is deliberately positional and lossless-but-terse
 * rather than a record per model.
 */
export type RunPriceTable = [
  string,
  number | null,
  number | null,
  number | null,
][]

/**
 * The catalog's prices, frozen for one run and carried in its journal.
 *
 * Pricing at EXECUTION time is the same freeze the run manifest already applies
 * to prompts and agents: a catalog edit mid-run must not split a run across two
 * price lists, and re-pricing history against today's catalog (what a read-time
 * derivation does) silently rewrites what past runs cost. Cost telemetry is
 * therefore stamped when the tokens are spent.
 *
 * Rows with no price at all are dropped — they'd resolve to "unpriced" either
 * way — which keeps the journal to the models that can actually contribute a
 * dollar figure. Each priced model contributes two rows (its native id and its
 * composite `provider:model`), since a step may record either form; at a few
 * hundred priced models that is tens of KB in the run's journal, read once per
 * run and replayed from the journal thereafter.
 */
export async function loadRunPriceTable(db: WfDb): Promise<RunPriceTable> {
  const map = await loadModelPriceMap(db)
  const table: RunPriceTable = []
  for (const [key, price] of map) {
    const { promptPerMTok, completionPerMTok, blendedPerMTok } = price
    if (promptPerMTok == null && completionPerMTok == null && blendedPerMTok == null) {
      continue
    }
    table.push([
      key,
      promptPerMTok ?? null,
      completionPerMTok ?? null,
      blendedPerMTok ?? null,
    ])
  }
  return table
}

/** Rehydrate a {@link RunPriceTable} into the map the cost helpers consume. */
export function priceMapFromTable(table: RunPriceTable): ModelPriceMap {
  const map: ModelPriceMap = new Map()
  for (const [key, promptPerMTok, completionPerMTok, blendedPerMTok] of table) {
    map.set(key, { promptPerMTok, completionPerMTok, blendedPerMTok })
  }
  return map
}

/**
 * Fold each run's agent-step token usage into a `{ totalTokens, costUsd }` pair,
 * for a set of run ids in one chunked pass.
 *
 * `totalTokens` is null when a run fired no agents; `costUsd` is null when none
 * of its agents' models were priced (partial pricing yields a best-effort sum).
 * Runs with no agent step at all are simply absent from the map.
 *
 * Scoped to the given runs ONLY — a parent whose work happened in children
 * reports what it did itself, which for a durable fan-out is near-nothing. That
 * is the correct answer to "what did this instance do?"; the wider number is
 * {@link rollUpRunCost}, and the two are kept separate because both are shown.
 *
 * The narrow sibling of {@link loadRunStats}: this answers the two numbers the
 * runs list and the child-run rows display, where that one also carries timing
 * and the frozen agent version. Shared so every displayed dollar figure is
 * derived the same way rather than each caller re-implementing the fold.
 */
export async function aggregateRunCost(
  db: WfDb,
  runIds: readonly string[],
): Promise<Map<string, { totalTokens: number | null; costUsd: number | null }>> {
  const out = new Map<
    string,
    { totalTokens: number | null; costUsd: number | null }
  >()
  if (runIds.length === 0) return out
  const [priceMap, usage] = await Promise.all([
    loadModelPriceMap(db),
    selectRunUsage(db, runIds),
  ])
  for (const [runId, rows] of groupUsageByRun(usage)) {
    const { totalTokens, costUsd } = foldUsage(rows, priceMap)
    out.set(runId, { totalTokens, costUsd })
  }
  return out
}
