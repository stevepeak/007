import type { WfLogger } from '../engine/logger'
import type { AgentConfig, WfDataClient } from '../server/protocol'

import {
  EMPTY_DRIVE_STATE,
  type EvalMatrixModel,
  type EvalMatrixPrompt,
  type EvalPlan,
  expandEvalCells,
} from './plan'
import { type EvalRunDrive, tickEvalRun } from './tick'

// Running a Goal — the orchestrator, with no framework in it.
//
// The caller creates the umbrella run with a frozen PLAN of every cell, then
// drives it one non-blocking tick at a time until the plan is exhausted. The
// tick itself lives in `./tick`; everything here is about launching a sweep and
// about the one driver that stays attached to it.
//
// What changed, and why it matters to a new caller: the orchestration used to
// live entirely in the caller's process, as a loop holding the only copy of the
// work list. If that process went away mid-sweep — a browser tab closing, an
// MCP request ending — the remaining cells were never launched and the run was
// stranded with nothing able to finish it. Now the plan is persisted on the run
// row, so an attached driver is an OPTIMIZATION (it makes progress every few
// seconds instead of every minute) rather than the only thing keeping the sweep
// alive. A host that wires the resume backstop picks up whatever is left.
//
// Errors on one cell don't abort the batch; the run is finalized over whatever
// results landed — and EVERY cell lands something, pass, fail, or error, so the
// run's totals always match what was requested.

export type { EvalMatrixModel, EvalMatrixPrompt }

/**
 * How long to wait for one cell's run to reach a terminal status.
 *
 * This MUST exceed the server's own bound on a failing agent node (see
 * `EVAL_NODE_EXECUTION` in `./execution-policy`), or it fires first and
 * we're back to a waiter that gives up before the thing it waits on can
 * possibly answer — which is exactly how a provider outage produced an eval
 * report with zero results and no explanation.
 */
const EVAL_WAIT_TIMEOUT_MS = 15 * 60_000
const EVAL_POLL_INTERVAL_MS = 3_000

/**
 * Concurrent runs one eval may have in flight. Each is a full agent call, so
 * this is the rate at which the whole matrix hits the model provider — the
 * knob that decides whether a large sweep is a workload or a denial of service.
 *
 * The default stays low because a big matrix against a struggling provider is
 * exactly how a 429 storm starts. Raising it is now much safer than it was —
 * the circuit breaker stops the run after three consecutive provider failures
 * and every cell records its own outcome — so the launch dialog offers the
 * choice rather than hard-coding one.
 */
export const DEFAULT_EVAL_CONCURRENCY = 2
/**
 * The values the launch dialog offers — coarse steps rather than a free-form
 * number, because the difference that matters is order-of-magnitude pressure on
 * the provider, not 5 versus 6. Each slot is one in-flight agent call; the runs
 * themselves each execute in their own Durable Object and don't contend
 * locally, so this bounds the model API and nothing else.
 */
export const EVAL_CONCURRENCY_CHOICES = [1, 2, 4, 8] as const

// The clamp ceiling is the largest offered choice, derived rather than restated
// so the two can't drift apart.
const MAX_EVAL_CONCURRENCY = Math.max(...EVAL_CONCURRENCY_CHOICES)

function clampConcurrency(n?: number) {
  return Math.max(
    1,
    Math.min(n ?? DEFAULT_EVAL_CONCURRENCY, MAX_EVAL_CONCURRENCY),
  )
}

export type RunEvalInput = {
  setIds: string[]
  /**
   * Run every cell against this agent config instead of the target's published
   * version — the agent editor testing its goals against UNSAVED edits. Nothing
   * is persisted on the AGENT; the config is frozen into the run's plan so a
   * resuming driver grades the same thing the launcher meant to. The matrix's
   * `modelId` / `promptBody` still layer on top of it, so a draft can be swept
   * across models and alternate prompts exactly like a published agent.
   * Omitted → the published version (every other caller).
   */
  configOverride?: AgentConfig
  /**
   * The model × prompt sweep. Omitted → a single plain run per sample on the
   * target's own saved model + prompt (preserves the pre-matrix behavior). When
   * present, every sample is run for each (model × prompt × attempt) cell.
   */
  matrix?: { models: EvalMatrixModel[]; prompts: EvalMatrixPrompt[] }
  concurrency?: number
  pollIntervalMs?: number
  timeoutMs?: number
  onProgress?: (p: { done: number; total: number }) => void
  /**
   * Fired the moment the umbrella run row exists (before any cell runs), so the
   * caller can close its dialog and navigate to the live report while the matrix
   * keeps fanning out in the background.
   */
  onStart?: (evalRunId: string) => void
}

/**
 * Create the umbrella run with its frozen plan, launching nothing.
 *
 * Split out from `runEval` because the two callers want different things after
 * it: an attached driver ticks the sweep to completion itself, while a caller
 * that cannot outlive the request — the MCP endpoint — starts the first batch
 * and leaves the rest to the host's resume backstop.
 */
export async function createEvalSweep(
  client: WfDataClient,
  input: RunEvalInput,
): Promise<{ evalRunId: string; plan: EvalPlan }> {
  const sets = await Promise.all(
    input.setIds.map((id) => client.getEvalSet(id)),
  )
  const rowIds = sets
    .filter((s): s is NonNullable<typeof s> => !!s)
    .flatMap((s) => s.rows.map((row) => row.id))

  const plan: EvalPlan = {
    version: 1,
    cells: expandEvalCells(rowIds, input.matrix),
    configOverride: input.configOverride,
    concurrency: clampConcurrency(input.concurrency),
    timeoutMs: input.timeoutMs ?? EVAL_WAIT_TIMEOUT_MS,
  }

  const { evalRunId } = await client.createEvalRun({
    setIds: input.setIds,
    total: plan.cells.length,
    plan,
  })
  return { evalRunId, plan }
}

/**
 * Drive a sweep by ticking it until it finishes.
 *
 * `budgetMs` bounds how long this driver stays attached — a caller that cannot
 * run indefinitely (anything inside a request) passes one and lets the backstop
 * take the rest. Omitted, it drives to completion, which is what a browser tab
 * does.
 *
 * Safe to run against a sweep another driver was previously attached to: state
 * is re-read from storage on every tick, so cells already in flight are polled
 * rather than started again.
 */
export async function driveEvalRun(
  client: WfDataClient,
  evalRunId: string,
  opts: {
    pollIntervalMs?: number
    budgetMs?: number
    onProgress?: (p: { done: number; total: number }) => void
    now?: () => number
    /** Where a cell that could not even record its own failure is reported. */
    logger?: WfLogger
  } = {},
): Promise<{ done: boolean }> {
  const pollIntervalMs = opts.pollIntervalMs ?? EVAL_POLL_INTERVAL_MS
  const now = opts.now ?? (() => Date.now())
  const deadline = opts.budgetMs == null ? null : now() + opts.budgetMs

  for (;;) {
    const drive = await client.getEvalRunDrive(evalRunId)
    if (!drive) return { done: false }
    // Another driver finished it between our read and this one, or a human
    // cancelled it. Either way there is nothing left to do.
    if (drive.status === 'completed' || drive.status === 'cancelled') {
      return { done: true }
    }
    if (!drive.plan) {
      // Created before plans were persisted. Nothing can resume it, and saying
      // so beats ticking forever against a run with no work list.
      throw new Error(
        `Eval run ${evalRunId} has no plan, so it cannot be driven. It predates resumable sweeps.`,
      )
    }

    const result = await tickEvalRun(client, {
      drive,
      now: now(),
      logger: opts.logger,
    })
    // Out of budget with cells left: this is the last save, so hand the run
    // back in the same write rather than leaving a heartbeat that would make it
    // look attended by a driver that has already gone.
    const handOff = !result.done && deadline != null && now() >= deadline
    await client.saveEvalRunDrive({
      evalRunId,
      driveState: result.state,
      release: handOff,
    })
    opts.onProgress?.({
      done: result.settledKeys.length,
      total: drive.plan.cells.length,
    })

    if (result.done) {
      await client.finalizeEvalRun({ evalRunId })
      return { done: true }
    }
    if (handOff) return { done: false }
    await new Promise((r) => setTimeout(r, pollIntervalMs))
  }
}

/**
 * Launch a sweep and stay attached to it until it finishes.
 *
 * The browser's path: the launch dialog calls this, `onStart` lets it navigate
 * to the live report, and the mutation keeps ticking for as long as the tab is
 * open. If the tab closes, the backstop finishes the sweep — which is new, and
 * the reason this no longer has to be the only driver.
 */
export async function runEval(
  client: WfDataClient,
  input: RunEvalInput,
): Promise<{ evalRunId: string }> {
  const { evalRunId } = await createEvalSweep(client, input)
  input.onStart?.(evalRunId)
  await driveEvalRun(client, evalRunId, {
    pollIntervalMs: input.pollIntervalMs,
    onProgress: input.onProgress,
  })
  return { evalRunId }
}

/** The empty drive state, re-exported for hosts wiring a resume backstop. */
export { EMPTY_DRIVE_STATE }
export type { EvalRunDrive }
