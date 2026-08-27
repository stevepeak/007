import { inArray } from 'drizzle-orm'

import type { WfDb } from '../client'
import { wfRun } from '../schema'

import { descendantRunIds, TERMINAL_RUN_STATUSES } from './runs-children'
import { loadModelPriceMap } from './runs-cost'
import { foldUsage, groupUsageByRun, selectRunUsage } from './runs-usage'
import { selectChunked } from './shared'

// ---------------------------------------------------------------------------
// Tree roll-up — what a run cost INCLUDING everything it spawned
// ---------------------------------------------------------------------------
//
// A run's own totals only describe the steps recorded against that run. Once a
// durable iteration runs each item as its own instance, the steps move with it:
// the local D1 holds a real ingest fan-out whose CHILD carries 12 steps and
// whose parent carries the loop and little else. Reading the parent's own cost
// there reports near-zero for a document that cost real money.
//
// So a parent needs a second, wider number. What follows is deliberately NOT a
// replacement for a run's own cost — both are true and they answer different
// questions ("what did this instance do?" vs "what did this upload cost?"). The
// runs list and the run viewer show the tree total with the own total behind it;
// `aggregateRunCost` in `runs-cost.ts` stays the narrow, own-run read.
//
// Derived at READ time rather than cached on the row when a run closes. The
// cached version is tempting — a parent parks until its children report, so it
// closes last and could fold their totals in as it goes — but a child that
// FAILS or times out never closes, and the parent's wait fires its own timeout
// instead. A cached roll-up would then silently under-count exactly the trees
// someone is most likely to be looking at. `pending` below reports that state
// instead of hiding it.

/** Set form of the shared terminal list, for the per-run membership test below. */
const TERMINAL: ReadonlySet<string> = new Set<string>(TERMINAL_RUN_STATUSES)

/**
 * A run plus its whole subtree, folded.
 *
 * Time is two numbers on purpose, and the distinction is the point:
 *
 * - A run's **elapsed** time stays its own wall clock (`started_at` →
 *   `finished_at`, which the caller already has) and it already covers the
 *   children, since a parent parks until they report.
 * - {@link computeMs} is **additive** across the tree. Children run
 *   concurrently, so this deliberately exceeds elapsed time — that gap is the
 *   whole return on durable fan-out, and collapsing the two into one summed
 *   number would read as elapsed and overstate it by the concurrency factor.
 */
export type RunTreeTotals = {
  /** Tokens across every run in the tree; null when none fired an agent. */
  totalTokens: number | null
  /** USD across every run in the tree; null when nothing in it was priced. */
  costUsd: number | null
  /** Every model used anywhere in the tree, deduped. */
  models: string[]
  /**
   * Summed AGENT-call time across the tree — the same "sum of each agent step's
   * own window" the per-run stat has always meant, widened to the tree. Null
   * when no agent step anywhere closed a window.
   */
  agentMs: number | null
  /**
   * Summed RUN time across the tree — additive, not elapsed, and the number
   * that shows a 12-item fan-out doing 40 minutes of work in 6 minutes of wall
   * clock. Only closed windows contribute, so a tree still in flight reports
   * the work finished so far rather than pretending an open run took no time.
   */
  computeMs: number | null
  /** The frozen agent version stamped on the tree's agent steps; null if none. */
  agentVersion: number | null
  /** The root's own wall clock, for callers that need a timing fallback. */
  rootWallMs: number | null
  /** Runs folded in, including the root. 1 means the root had no children. */
  runCount: number
  /**
   * Runs in the tree that have not reached a terminal state. Non-zero means
   * these totals are a floor, not a final figure.
   */
  pending: number
}

/**
 * Roll each root's whole subtree into one set of totals.
 *
 * Costs three indexed queries for a one-level fan-out — walk the tree, sum
 * usage per (run, model), read the run windows — and none of them selects a
 * step's `meta`, which is what makes it affordable at all (see `runs-usage.ts`).
 * A root with no children costs the same three and returns `runCount: 1`.
 */
export async function rollUpRunCost(
  db: WfDb,
  rootIds: readonly string[],
): Promise<Map<string, RunTreeTotals>> {
  const out = new Map<string, RunTreeTotals>()
  if (rootIds.length === 0) return out

  const trees = await descendantRunIds(db, rootIds)
  const allIds = [...new Set([...trees.values()].flat())]

  const [priceMap, usage, runRows] = await Promise.all([
    loadModelPriceMap(db),
    selectRunUsage(db, allIds),
    selectChunked(allIds, (ids) =>
      db
        .select({
          id: wfRun.id,
          status: wfRun.status,
          startedAt: wfRun.startedAt,
          finishedAt: wfRun.finishedAt,
        })
        .from(wfRun)
        .where(inArray(wfRun.id, ids)),
    ),
  ])

  const usageByRun = groupUsageByRun(usage)
  const windows = new Map(runRows.map((r) => [r.id, r]))
  const closedMs = (id: string): number | null => {
    const w = windows.get(id)
    const start = w?.startedAt?.getTime()
    const end = w?.finishedAt?.getTime()
    return start != null && end != null && end >= start ? end - start : null
  }

  for (const [root, ids] of trees) {
    // A root whose row is gone (deleted between the walk and this read) is
    // simply absent from the result, matching every other id-keyed read here.
    // Its descendants were resolved FROM live rows, so those are all present.
    if (!windows.has(root)) continue
    const folded = foldUsage(
      ids.flatMap((id) => usageByRun.get(id) ?? []),
      priceMap,
    )
    let computeMs = 0
    let hasCompute = false
    let pending = 0
    for (const id of ids) {
      const status = windows.get(id)?.status
      if (status != null && !TERMINAL.has(status)) pending += 1
      const ms = closedMs(id)
      if (ms != null) {
        computeMs += ms
        hasCompute = true
      }
    }
    out.set(root, {
      totalTokens: folded.totalTokens,
      costUsd: folded.costUsd,
      models: folded.models,
      agentMs: folded.agentMs,
      computeMs: hasCompute ? computeMs : null,
      agentVersion: folded.agentVersion,
      rootWallMs: closedMs(root),
      runCount: ids.length,
      pending,
    })
  }
  return out
}

/**
 * Per-run cost / speed / model, keyed by run id — powers the eval report's
 * per-sample stats and its rolled-up averages.
 *
 * Every figure is scoped to the AGENT CALL(S): tokens/cost sum the agent steps'
 * usage (tools, the trigger and outputs carry none), and `durationMs` is those
 * steps' own wall clock — never the whole run, and never the judge/test grading,
 * which runs after the wf_run finishes and records no steps.
 *
 * Scoped to the run's whole TREE, though, not just its own row: a sample whose
 * target workflow fans out durably does its work in child instances, and an
 * eval that priced only the parent would compare samples on a number that has
 * nothing to do with what they cost.
 */
export type RunStats = {
  totalTokens: number | null
  costUsd: number | null
  models: string[]
  /** Agent-call duration in ms, summed across the tree. Falls back to the run's
   *  wall clock when no agent step recorded timing; null when neither exists. */
  durationMs: number | null
  /**
   * The agent version this run actually executed, frozen into the manifest at
   * start and stamped onto each agent step.
   *
   * The live catalog cannot answer this after the fact, and for evals that is
   * the whole point: a Goal with no pinned `targetVersion` floats to latest, so
   * republishing the agent leaves the sample's snapshot hash IDENTICAL. Same
   * hash, different agent, different score. This is the axis that says so.
   *
   * Null when no agent step recorded one (a workflow-target eval, or a run that
   * predates the stamp).
   */
  agentVersion: number | null
}

/**
 * Load {@link RunStats} for a set of runs. A run with no id in `runIds` is
 * absent from the returned map; a run that exists but fired no agents is
 * present with null figures.
 */
export async function loadRunStats(
  db: WfDb,
  runIds: string[],
): Promise<Map<string, RunStats>> {
  const out = new Map<string, RunStats>()
  // An eval run hands over one id per sample, so `runIds` is matrix-sized. The
  // reads underneath all chunk.
  const totals = await rollUpRunCost(db, runIds)
  for (const [runId, t] of totals) {
    out.set(runId, {
      totalTokens: t.totalTokens,
      costUsd: t.costUsd,
      models: t.models,
      durationMs: t.agentMs ?? t.rootWallMs,
      agentVersion: t.agentVersion,
    })
  }
  return out
}
