import { errorFeedLine } from '../engine/error-detail'
import { TERMINAL_RUN_STATUSES } from '../engine/run-progress'
import type { WfDataClient } from '../server/protocol'

import { type EvalCell, type EvalPlan, evalCellKey } from './plan'

// Running a Goal, start to finish, as one durable process.
//
// Each cell is three journaled steps: start its run, wait to be told it settled,
// grade it. Step names are built from the cell's index in the plan, never from
// completion order, because a replay hands cells to workers in a different order
// and the journal is addressed by name.
//
// The wake-up carries nothing. `wf_run` is what says how a cell ended, so a lost
// wake-up costs only a wait until the timeout, after which the same read decides.
//
// Every exit path for a cell writes a `wf_eval_result`: pass, fail, or error.
// `finalizeEvalRun` rolls up the rows that exist, so a cell that writes nothing
// would silently shrink the total. That is why a failed write throws, letting the
// step retry it.

/**
 * Consecutive failed model calls before the sweep stops launching new cells. Once
 * the provider has refused three in a row, the rest are near-certain to fail too.
 * Timeouts do NOT count: they say nothing about the provider's health.
 *
 * The tally is held in memory and rebuilt on replay from journaled outcomes, in
 * whatever order they replay. That can shift when the breaker trips by a cell or
 * two, which is harmless, because the decision to skip a cell is made inside that
 * cell's own journaled step and so can never be revisited.
 */
export const MAX_CONSECUTIVE_CELL_ERRORS = 3

/** The slice of a Cloudflare `WorkflowStep` a sweep uses. */
export type EvalSweepStep = {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>
  waitForEvent(
    name: string,
    opts: { type: string; timeout: number },
  ): Promise<unknown>
}

/** What a settled cell says about the provider's health. */
type CellOutcome = 'ok' | 'error' | 'neutral'

type StartedCell =
  | { kind: 'run'; wfRunId: string; eventType: string }
  | { kind: 'settled'; outcome: CellOutcome }
  | { kind: 'stopped' }

export async function runEvalSweep(
  client: WfDataClient,
  step: EvalSweepStep,
  input: { evalRunId: string },
): Promise<void> {
  const { evalRunId } = input

  // The plan can outgrow a step's 1 MiB return cap, so steps return indices and
  // read the plan themselves. It is frozen at creation, so one read per isolate.
  let plan: EvalPlan | null = null
  const readPlan = async (): Promise<EvalPlan> => {
    if (plan) return plan
    const drive = await client.getEvalRunDrive(evalRunId)
    if (!drive?.plan) {
      throw new Error(
        `Eval run ${evalRunId} has no plan, so it cannot be run. It predates resumable sweeps.`,
      )
    }
    plan = drive.plan
    return plan
  }

  const work = await step.do('load', async () => {
    const drive = await client.getEvalRunDrive(evalRunId)
    const loaded = await readPlan()
    const settled = new Set(drive?.settledKeys ?? [])
    return {
      // A restarted sweep skips whatever already has a verdict.
      pending: loaded.cells.flatMap((cell, index) => {
        return settled.has(evalCellKey(cell)) ? [] : [index]
      }),
      concurrency: loaded.concurrency,
      timeoutMs: loaded.timeoutMs,
    }
  })

  let consecutiveErrors = 0
  const providerDown = () => consecutiveErrors >= MAX_CONSECUTIVE_CELL_ERRORS
  const tally = (outcome: CellOutcome) => {
    if (outcome === 'ok') consecutiveErrors = 0
    if (outcome === 'error') consecutiveErrors += 1
  }

  const record = async (args: {
    cell: EvalCell
    error: string
    wfRunId?: string
  }) => {
    const { cell, error, wfRunId } = args
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
  }

  const startCell = async (index: number): Promise<StartedCell> => {
    const drive = await client.getEvalRunDrive(evalRunId, { withPlan: false })
    if (drive?.status === 'cancelled' || drive?.status === 'completed') {
      return { kind: 'stopped' }
    }
    const current = await readPlan()
    const cell = current.cells[index]
    if (providerDown()) {
      await record({
        cell,
        error: `Skipped — the model provider failed ${MAX_CONSECUTIVE_CELL_ERRORS} calls in a row, so the rest of this run was not launched.`,
      })
      return { kind: 'settled', outcome: 'neutral' }
    }
    // A decision is one provider call with no `wf_run` behind it, so it settles
    // here and there is nothing to wait for.
    if (current.mode === 'decision') {
      try {
        await client.runDecisionEvalCell({
          evalRunId,
          rowId: cell.rowId,
          modelId: cell.modelId,
          attempt: cell.attempt,
          decisionJudgeModelId: current.decisionJudgeModelId,
          config: current.configOverride,
        })
        return { kind: 'settled', outcome: 'ok' }
      } catch (err) {
        await record({ cell, error: errorFeedLine(err) })
        return { kind: 'settled', outcome: 'error' }
      }
    }
    // Unique per attempt, so a run left over from before a restart can't wake
    // the wait of the run that replaced it.
    const eventType = `cell-${crypto.randomUUID()}`
    try {
      const { wfRunId } = await client.startEvalRun({
        evalRunId,
        rowId: cell.rowId,
        modelId: cell.modelId,
        promptBody: cell.promptBody,
        config: current.configOverride,
        sweepEvent: eventType,
      })
      return { kind: 'run', wfRunId, eventType }
    } catch (err) {
      // A bad target or a refused sample. It says nothing about the provider.
      await record({ cell, error: errorFeedLine(err) })
      return { kind: 'settled', outcome: 'neutral' }
    }
  }

  const gradeCell = async (args: {
    index: number
    wfRunId: string
  }): Promise<CellOutcome> => {
    const { index, wfRunId } = args
    const current = await readPlan()
    const cell = current.cells[index]
    const statuses = await client.getRunStatuses([wfRunId])
    const status = statuses[wfRunId]
    if (!status || !TERMINAL_RUN_STATUSES.has(status.status)) {
      await record({
        cell,
        wfRunId,
        error: `The run was still executing after ${Math.round(current.timeoutMs / 60_000)} minutes; the report stopped waiting for it.`,
      })
      return 'neutral'
    }
    if (status.status !== 'done' && status.status !== 'completed') {
      // A failed or cancelled run has no gradeable output. Grading it anyway
      // would blame the Sample for what was an infrastructure failure.
      await record({
        cell,
        wfRunId,
        error: status.error ?? `The run ended as "${status.status}".`,
      })
      return 'error'
    }
    try {
      await client.gradeEvalResult({
        evalRunId,
        rowId: cell.rowId,
        wfRunId,
        modelId: cell.modelId,
        promptLabel: cell.promptLabel,
        promptBody: cell.promptBody,
        attempt: cell.attempt,
        decisionJudgeModelId: current.decisionJudgeModelId,
      })
      return 'ok'
    } catch (err) {
      // The judge blew up, not the target. Still a cell with no verdict.
      await record({ cell, wfRunId, error: errorFeedLine(err) })
      return 'neutral'
    }
  }

  let stopped = false
  const runCell = async (index: number) => {
    const started = await step.do(`start:${index}`, () => startCell(index))
    if (started.kind === 'stopped') {
      stopped = true
      return
    }
    if (started.kind === 'settled') {
      tally(started.outcome)
      return
    }
    try {
      await step.waitForEvent(`await:${index}`, {
        type: started.eventType,
        timeout: work.timeoutMs,
      })
    } catch {
      // Timed out. Grading reads `wf_run`, which says whether the run finished
      // without managing to report it.
    }
    tally(
      await step.do(`grade:${index}`, () => {
        return gradeCell({ index, wfRunId: started.wfRunId })
      }),
    )
  }

  let cursor = 0
  const worker = async () => {
    while (!stopped && cursor < work.pending.length) {
      const index = work.pending[cursor]
      cursor += 1
      await runCell(index)
    }
  }
  // `allSettled` so one cell's failure can't abandon cells other workers have
  // already started. A sweep that failed this way restarts and skips what landed.
  const workers = await Promise.allSettled(
    Array.from(
      { length: Math.min(work.concurrency, work.pending.length) },
      () => worker(),
    ),
  )
  for (const result of workers) {
    if (result.status === 'rejected') throw result.reason
  }

  await step.do('finalize', async () => {
    const drive = await client.getEvalRunDrive(evalRunId, { withPlan: false })
    if (drive?.status === 'cancelled' || drive?.status === 'completed') return
    await client.finalizeEvalRun({ evalRunId })
  })
}
