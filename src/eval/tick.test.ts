import { describe, expect, test } from 'bun:test'

import type { WfDataClient } from '../server/protocol'

import {
  EMPTY_DRIVE_STATE,
  evalCellKey,
  type EvalCell,
  type EvalDriveState,
  type EvalPlan,
} from './plan'
import { MAX_CONSECUTIVE_CELL_ERRORS, tickEvalRun, type EvalRunDrive } from './tick'

/**
 * A tick is the whole of the orchestration now, and the property everything
 * else rests on is that it can be repeated safely. A sweep is driven by
 * whichever process happens to be around — a browser tab, then a cron a minute
 * later — so "start the cells that have neither finished nor started" has to be
 * true of a run row rather than of a driver's memory. Get that wrong and a cell
 * runs twice: two live agent calls, two model bills, and a report with two
 * verdicts for one square.
 */

function stubClient(partial: Partial<WfDataClient>): WfDataClient {
  return partial as WfDataClient
}

function planOf(cells: EvalCell[], over: Partial<EvalPlan> = {}): EvalPlan {
  return {
    version: 1,
    cells,
    concurrency: 2,
    timeoutMs: 15 * 60_000,
    ...over,
  }
}

function driveOf(
  plan: EvalPlan,
  over: Partial<Omit<EvalRunDrive, 'plan'>> = {},
): EvalRunDrive {
  return {
    evalRunId: 'er_1',
    status: 'running',
    plan,
    driveState: EMPTY_DRIVE_STATE,
    settledKeys: [],
    ...over,
  }
}

function rows (n: number): EvalCell[] {
  return Array.from({ length: n }, (_, i) => ({ rowId: `row_${i}` }))
}

describe('tickEvalRun — starting cells', () => {
  test('starts no more than the plan’s concurrency and records them in flight', async () => {
    const started: string[] = []
    const client = stubClient({
      startEvalRun: async ({ rowId }) => {
        started.push(rowId)
        return { wfRunId: `run_${rowId}` }
      },
    })
    const out = await tickEvalRun(client, { drive: driveOf(planOf(rows(5))) })
    expect(started).toEqual(['row_0', 'row_1'])
    expect(out.started).toBe(2)
    expect(out.done).toBe(false)
    expect(out.state.inflight.map((i) => i.wfRunId)).toEqual([
      'run_row_0',
      'run_row_1',
    ])
  })

  test('never restarts a cell that already has a result', async () => {
    const started: string[] = []
    const client = stubClient({
      startEvalRun: async ({ rowId }) => {
        started.push(rowId)
        return { wfRunId: `run_${rowId}` }
      },
    })
    // row_0 was graded by whoever drove this run before us.
    const drive = driveOf(planOf(rows(3)), {
      settledKeys: [evalCellKey({ rowId: 'row_0' })],
    })
    await tickEvalRun(client, { drive })
    expect(started).toEqual(['row_1', 'row_2'])
  })

  test('never restarts a cell another driver left in flight', async () => {
    const started: string[] = []
    const client = stubClient({
      startEvalRun: async ({ rowId }) => {
        started.push(rowId)
        return { wfRunId: `run_${rowId}` }
      },
      getRunStatus: async () => ({ status: 'running', error: null }) as never,
    })
    const inflight: EvalDriveState = {
      ...EMPTY_DRIVE_STATE,
      inflight: [
        { cell: { rowId: 'row_0' }, wfRunId: 'run_old', startedAt: Date.now() },
      ],
    }
    const drive = driveOf(planOf(rows(3)), { driveState: inflight })
    const out = await tickEvalRun(client, { drive })
    // One slot was already occupied, so only one new cell starts — and it is
    // not the one that is already running.
    expect(started).toEqual(['row_1'])
    expect(out.state.inflight).toHaveLength(2)
  })

  test('distinguishes matrix cells of the same sample', async () => {
    const started: unknown[] = []
    const client = stubClient({
      startEvalRun: async (input) => {
        started.push(input)
        return { wfRunId: 'run_1' }
      },
    })
    const cells: EvalCell[] = [
      { rowId: 'row_0', modelId: 'm1', promptLabel: 'base', attempt: 0 },
      { rowId: 'row_0', modelId: 'm1', promptLabel: 'base', attempt: 1 },
    ]
    // The first attempt is graded; the second is a different cell and must run.
    const drive = driveOf(planOf(cells, { concurrency: 4 }), {
      settledKeys: [evalCellKey(cells[0])],
    })
    await tickEvalRun(client, { drive })
    expect(started).toHaveLength(1)
  })

  test('records a cell whose start threw, rather than losing it', async () => {
    const failures: { rowId: string; error: string }[] = []
    const client = stubClient({
      startEvalRun: async () => {
        throw new Error('Eval runs are not configured for this host.')
      },
      recordEvalFailure: async ({ rowId, error }) => {
        failures.push({ rowId, error })
        return {} as never
      },
    })
    const out = await tickEvalRun(client, {
      drive: driveOf(planOf(rows(1), { concurrency: 1 })),
    })
    expect(failures[0]?.error).toContain('not configured')
    // Every cell writes a row, so the run's total stays honest and it can
    // finalize instead of waiting forever on a cell that never started.
    expect(out.done).toBe(true)
  })
})

describe('tickEvalRun — settling cells', () => {
  const inflightOf = (cell: EvalCell, startedAt = Date.now()) => ({
    ...EMPTY_DRIVE_STATE,
    inflight: [{ cell, wfRunId: 'run_1', startedAt }],
  })

  test('grades a run that reached a terminal success', async () => {
    let graded: unknown = null
    const client = stubClient({
      getRunStatus: async () => ({ status: 'done', error: null }) as never,
      gradeEvalResult: async (input) => {
        graded = input
        return {} as never
      },
      startEvalRun: async () => ({ wfRunId: 'run_2' }),
    })
    const out = await tickEvalRun(client, {
      drive: driveOf(planOf(rows(1)), {
        driveState: inflightOf({ rowId: 'row_0' }),
      }),
    })
    expect(graded).toMatchObject({ rowId: 'row_0', wfRunId: 'run_1' })
    expect(out.settled).toBe(1)
    expect(out.done).toBe(true)
  })

  // `done` means the Output was reached and the answer is final; branches that
  // don't feed it may still be draining. A waiter that held out for `completed`
  // would sit through that drain for no reason.
  test('accepts `completed` as well as `done`', async () => {
    let graded = false
    const client = stubClient({
      getRunStatus: async () => {
        return { status: 'completed', error: null } as never
      },
      gradeEvalResult: async () => {
        graded = true
        return {} as never
      },
    })
    await tickEvalRun(client, {
      drive: driveOf(planOf(rows(1)), {
        driveState: inflightOf({ rowId: 'row_0' }),
      }),
    })
    expect(graded).toBe(true)
  })

  test('records a failed run instead of grading it', async () => {
    let graded = false
    const failures: string[] = []
    const client = stubClient({
      getRunStatus: async () => {
        return { status: 'failed', error: 'provider 503' } as never
      },
      gradeEvalResult: async () => {
        graded = true
        return {} as never
      },
      recordEvalFailure: async ({ error }) => {
        failures.push(error)
        return {} as never
      },
    })
    const out = await tickEvalRun(client, {
      drive: driveOf(planOf(rows(1)), {
        driveState: inflightOf({ rowId: 'row_0' }),
      }),
    })
    // Grading a failed run produces a `fail` verdict that blames the Sample for
    // an infrastructure outage.
    expect(graded).toBe(false)
    expect(failures).toEqual(['provider 503'])
    expect(out.state.consecutiveErrors).toBe(1)
  })

  test('times a cell out without blaming the provider', async () => {
    const failures: string[] = []
    const client = stubClient({
      getRunStatus: async () => ({ status: 'running', error: null }) as never,
      recordEvalFailure: async ({ error }) => {
        failures.push(error)
        return {} as never
      },
    })
    const now = 10_000_000
    const out = await tickEvalRun(client, {
      drive: driveOf(planOf(rows(1), { timeoutMs: 60_000 }), {
        driveState: inflightOf({ rowId: 'row_0' }, now - 61_000),
      }),
      now,
    })
    expect(failures[0]).toContain('stopped waiting')
    // A timeout says nothing about the provider's health, so the breaker stays
    // where it was.
    expect(out.state.consecutiveErrors).toBe(0)
  })
})

describe('tickEvalRun — the circuit breaker', () => {
  test('latches after consecutive failures and drains the rest into skips', async () => {
    const failures: string[] = []
    let starts = 0
    const client = stubClient({
      getRunStatus: async () => {
        return { status: 'failed', error: 'provider down' } as never
      },
      recordEvalFailure: async ({ error }) => {
        failures.push(error)
        return {} as never
      },
      startEvalRun: async () => {
        starts += 1
        return { wfRunId: `run_${starts}` }
      },
    })
    const cells = rows(10)
    // Two already-failed cells carried in, plus a third failing this tick.
    const drive = driveOf(planOf(cells, { concurrency: 1 }), {
      driveState: {
        ...EMPTY_DRIVE_STATE,
        consecutiveErrors: MAX_CONSECUTIVE_CELL_ERRORS - 1,
        inflight: [
          { cell: cells[0], wfRunId: 'run_0', startedAt: Date.now() },
        ],
      },
    })
    const out = await tickEvalRun(client, { drive })
    expect(out.state.providerDown).toBe(true)
    // Nothing new was launched at a provider that just refused three calls...
    expect(starts).toBe(0)
    // ...and every remaining cell still got a row, so the run can finalize with
    // an honest total rather than hanging at a short one.
    expect(out.done).toBe(true)
    expect(failures).toHaveLength(10)
    expect(failures.at(-1)).toContain('failed 3 calls in a row')
  })

  test('a success clears the tally', async () => {
    const client = stubClient({
      getRunStatus: async () => ({ status: 'done', error: null }) as never,
      gradeEvalResult: async () => ({}) as never,
      startEvalRun: async () => ({ wfRunId: 'run_2' }),
    })
    const out = await tickEvalRun(client, {
      drive: driveOf(planOf(rows(1)), {
        driveState: {
          ...EMPTY_DRIVE_STATE,
          consecutiveErrors: 2,
          inflight: [
            { cell: { rowId: 'row_0' }, wfRunId: 'run_1', startedAt: Date.now() },
          ],
        },
      }),
    })
    expect(out.state.consecutiveErrors).toBe(0)
    expect(out.state.providerDown).toBe(false)
  })
})

describe('tickEvalRun — finishing', () => {
  test('is not done while a cell is still running', async () => {
    const client = stubClient({
      getRunStatus: async () => ({ status: 'running', error: null }) as never,
    })
    const out = await tickEvalRun(client, {
      drive: driveOf(planOf(rows(1)), {
        driveState: {
          ...EMPTY_DRIVE_STATE,
          inflight: [
            { cell: { rowId: 'row_0' }, wfRunId: 'run_1', startedAt: Date.now() },
          ],
        },
      }),
    })
    expect(out.done).toBe(false)
    expect(out.state.inflight).toHaveLength(1)
  })

  // A Goal with no samples launched and finalized an empty report before plans
  // existed, and still does: an empty cell list is a plan that is already
  // satisfied, not a broken one.
  test('is immediately done for a plan with no cells', async () => {
    const out = await tickEvalRun(stubClient({}), {
      drive: driveOf(planOf([])),
    })
    expect(out.done).toBe(true)
    expect(out.started).toBe(0)
  })

  test('refuses a run with no plan rather than ticking against nothing', async () => {
    await expect(
      tickEvalRun(stubClient({}), {
        drive: { ...driveOf(planOf(rows(1))), plan: null },
      }),
    ).rejects.toThrow(/no plan/)
  })

  test('drops an in-flight entry another driver already graded', async () => {
    let polled = 0
    const client = stubClient({
      getRunStatus: async () => {
        polled += 1
        return { status: 'running', error: null } as never
      },
    })
    const cell = { rowId: 'row_0' }
    const out = await tickEvalRun(client, {
      drive: driveOf(planOf([cell]), {
        settledKeys: [evalCellKey(cell)],
        driveState: {
          ...EMPTY_DRIVE_STATE,
          inflight: [{ cell, wfRunId: 'run_1', startedAt: Date.now() }],
        },
      }),
    })
    // The result row wins over our stale in-flight note: no poll, no re-grade.
    expect(polled).toBe(0)
    expect(out.state.inflight).toHaveLength(0)
    expect(out.done).toBe(true)
  })
})
