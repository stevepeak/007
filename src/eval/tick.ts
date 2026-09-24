import type { WfDataClient } from '../server/protocol'

import {
  type EvalCell,
  type EvalDriveState,
  type EvalInflightCell,
  type EvalPlan,
  evalCellKey,
} from './plan'

// One step of a sweep, and the whole of the orchestration.
//
// The previous orchestrator was a loop that started a cell, BLOCKED on it for
// up to fifteen minutes, graded it, and moved on — correct only for as long as
// the process running the loop stayed alive. That held for a browser tab and
// for the old long-lived stdio MCP process; it stopped holding the moment MCP
// became a Cloudflare Worker request, whose context is torn down the instant it
// answers. The sweep died before its first cell ever started, leaving the run
// at `queued` with nothing anywhere explaining why.
//
// A tick never blocks on a run. It polls what is in flight ONCE, settles
// whatever finished, starts as many new cells as the concurrency budget allows,
// and returns. Progress is made ACROSS ticks rather than within one, so no
// driver needs to outlive a single short invocation — which is what lets a
// once-a-minute cron finish a sweep whose launcher is long gone.
//
// A run has TWO success states: `done` (the Output was reached — the answer is
// final and persisted — while branches that don't feed it are still draining)
// and `completed` (nothing left to run). A waiter after an ANSWER must accept
// both; only a waiter for the graph to fall quiet holds out for `completed`.
const RUN_TERMINAL = new Set(['done', 'completed', 'failed', 'cancelled'])

/**
 * Consecutive failed model calls before the run stops launching new cells. Once
 * the provider has refused three in a row, the rest are near-certain to fail
 * too — continuing only burns time and hammers a service that is already down.
 * Client-side timeouts do NOT count toward this: they say nothing about the
 * provider's health.
 *
 * The tally lives in the persisted drive state rather than in a local variable
 * because a provider outage outlasts a tick by orders of magnitude — a breaker
 * that reset every minute would be no breaker at all.
 */
export const MAX_CONSECUTIVE_CELL_ERRORS = 3

/** What a driver needs to advance a run, as read back from storage. */
export type EvalRunDrive = {
  evalRunId: string
  status: string
  /** Null for runs created before plans were persisted — those can't resume. */
  plan: EvalPlan | null
  driveState: EvalDriveState
  /** `evalCellKey` of every cell that already has a result row. */
  settledKeys: string[]
}

export type EvalTickResult = {
  /** The new drive state — the caller persists it. */
  state: EvalDriveState
  /** Every cell has a result and nothing is in flight; the caller finalizes. */
  done: boolean
  /** Cells whose runs were launched by this tick. */
  started: number
  /** Cells that reached a verdict (graded or recorded as failed) in this tick. */
  settled: number
  /** Updated settled set, so a caller ticking in a loop needn't re-read. */
  settledKeys: string[]
}

/**
 * Advance one eval run by a single non-blocking step.
 *
 * Every exit path for a cell writes a `wf_eval_result` — pass, fail, or error.
 * That invariant is what keeps a run's totals honest: `finalizeEvalRun` rolls up
 * the rows that exist, so a cell that writes nothing silently shrinks the total
 * and the report reads as though the cell was never requested. It is also what
 * makes the tick safe to repeat: a settled cell is never started again.
 */
export async function tickEvalRun(
  client: WfDataClient,
  input: { drive: EvalRunDrive; now?: number },
): Promise<EvalTickResult> {
  const { drive } = input
  const now = input.now ?? Date.now()
  const plan = drive.plan
  if (!plan) {
    throw new Error(
      'This eval run was created before sweeps were resumable, so there is no plan to resume from.',
    )
  }
  const evalRunId = drive.evalRunId
  const settled = new Set(drive.settledKeys)
  let { consecutiveErrors, providerDown } = drive.driveState
  let started = 0
  let settledNow = 0

  // Record a cell that produced no gradeable run. Never throws: a failure to
  // write the failure would drop the cell from the run's totals entirely, which
  // is the exact silence this whole path exists to prevent.
  const record = async (cell: EvalCell, error: string, wfRunId?: string) => {
    try {
      await client.recordEvalFailure({
        evalRunId,
        rowId: cell.rowId,
        wfRunId,
        error,
        modelId: cell.modelId,
        promptLabel: cell.promptLabel,
        promptBody: cell.promptBody,
        attempt: cell.attempt,
      })
    } catch (e: unknown) {
      console.error(`[wf] eval failure not recorded for ${cell.rowId}:`, e)
      // Deliberately NOT marked settled: leaving it unsettled means the next
      // tick tries again, which is better than a cell that vanishes from the
      // totals because one write blipped.
      return
    }
    settled.add(evalCellKey(cell))
    settledNow += 1
  }

  // ── 1. Poll what is in flight ──────────────────────────────────────────────
  // Anything another driver already graded drops out first, so a cell is never
  // settled twice.
  const inflight = drive.driveState.inflight.filter(
    (i) => !settled.has(evalCellKey(i.cell)),
  )
  const stillInflight: EvalInflightCell[] = []
  for (const entry of inflight) {
    // `getRunStatus`, not `getRun`: this reads exactly two fields, once per
    // in-flight cell per tick. On `getRun` it was a full run-inspector load —
    // every step's tool IO, the whole log feed, and the serialized graph.
    const status = await client.getRunStatus(entry.wfRunId)
    if (status && RUN_TERMINAL.has(status.status)) {
      if (status.status === 'done' || status.status === 'completed') {
        try {
          await client.gradeEvalResult({
            evalRunId,
            rowId: entry.cell.rowId,
            wfRunId: entry.wfRunId,
            modelId: entry.cell.modelId,
            promptLabel: entry.cell.promptLabel,
            promptBody: entry.cell.promptBody,
            attempt: entry.cell.attempt,
          })
          settled.add(evalCellKey(entry.cell))
          settledNow += 1
          consecutiveErrors = 0
        } catch (err) {
          // The judge blew up, not the target. Still a cell with no verdict.
          await record(
            entry.cell,
            err instanceof Error ? err.message : String(err),
            entry.wfRunId,
          )
        }
      } else {
        // A failed or cancelled run has no gradeable output. Grading it anyway
        // would produce a `fail` verdict that blames the Sample for what was an
        // infrastructure failure — the other half of "pass rate 0, no idea why".
        consecutiveErrors += 1
        if (consecutiveErrors >= MAX_CONSECUTIVE_CELL_ERRORS) providerDown = true
        await record(
          entry.cell,
          status.error ?? `The run ended as "${status.status}".`,
          entry.wfRunId,
        )
      }
      continue
    }
    if (now - entry.startedAt > plan.timeoutMs) {
      // Not a provider verdict — the run may still be going — so this does NOT
      // trip the breaker.
      await record(
        entry.cell,
        `The run was still executing after ${Math.round(plan.timeoutMs / 60_000)} minutes; the report stopped waiting for it.`,
        entry.wfRunId,
      )
      continue
    }
    stillInflight.push(entry)
  }

  // ── 2. Start what there is room for ────────────────────────────────────────
  const claimed = new Set(stillInflight.map((i) => evalCellKey(i.cell)))
  const remaining = plan.cells.filter((c) => {
    const key = evalCellKey(c)
    return !settled.has(key) && !claimed.has(key)
  })

  if (providerDown) {
    // The breaker is latched: drain the rest into recorded skips rather than
    // leaving a run that can never finish. Every cell still gets its row, so the
    // report says what happened instead of showing a short total.
    for (const cell of remaining) {
      await record(
        cell,
        `Skipped — the model provider failed ${MAX_CONSECUTIVE_CELL_ERRORS} calls in a row, so the rest of this run was not launched.`,
      )
    }
  } else {
    const slots = Math.max(0, plan.concurrency - stillInflight.length)
    for (const cell of remaining.slice(0, slots)) {
      try {
        const { wfRunId } = await client.startEvalRun({
          evalRunId,
          rowId: cell.rowId,
          modelId: cell.modelId,
          promptBody: cell.promptBody,
          config: plan.configOverride,
        })
        stillInflight.push({ cell, wfRunId, startedAt: now })
        started += 1
      } catch (err) {
        // `startEvalRun` threw — a bad target, a missing row, the host hook
        // unwired. The cell gets its row and the sweep carries on.
        await record(cell, err instanceof Error ? err.message : String(err))
      }
    }
  }

  const done =
    stillInflight.length === 0 &&
    plan.cells.every((c) => settled.has(evalCellKey(c)))

  return {
    state: {
      version: 1,
      inflight: stillInflight,
      consecutiveErrors,
      providerDown,
    },
    done,
    started,
    settled: settledNow,
    settledKeys: [...settled],
  }
}
