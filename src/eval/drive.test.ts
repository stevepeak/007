import { describe, expect, test } from 'bun:test'

import type { WfDataClient } from '../server/protocol'

import {
  EMPTY_DRIVE_STATE,
  evalCellKey,
  type EvalDriveState,
  type EvalPlan,
} from './plan'
import { driveEvalRun } from './run-eval'

/**
 * The hand-off. A driver that stops with cells left has to say so, or its own
 * last heartbeat makes the run look attended for a full stale window and the
 * backstop leaves it alone — which is the original bug wearing a different hat:
 * a sweep nobody is driving that nothing will pick up.
 */

function stubClient(partial: Partial<WfDataClient>): WfDataClient {
  return partial as WfDataClient
}

function plan (n: number, concurrency = 1): EvalPlan {
  return {
  version: 1,
  cells: Array.from({ length: n }, (_, i) => ({ rowId: `row_${i}` })),
  concurrency,
  timeoutMs: 60_000,
}
}

/**
 * A stand-in for the run row, not just for the client.
 *
 * The drive loop's exit condition is "every planned cell has a result", read
 * back from storage each tick — so a stub that accepts `gradeEvalResult` without
 * remembering it never terminates. Writing a result here settles its cell,
 * exactly as the real `wf_eval_result` insert does.
 */
function driveHarness(
  cells: number,
  opts: { cellsFinish?: boolean } = {},
  over: Partial<WfDataClient> = {},
) {
  const saves: { release?: boolean; state: EvalDriveState }[] = []
  const reads: { withPlan?: boolean }[] = []
  let state = EMPTY_DRIVE_STATE
  const settledKeys: string[] = []
  const graded: string[] = []
  const client = stubClient({
    getEvalRunDrive: async (evalRunId: string, o?: { withPlan?: boolean }) => {
      reads.push({ withPlan: o?.withPlan })
      return {
        evalRunId,
        status: 'running',
        plan: o?.withPlan === false ? null : plan(cells),
        driveState: state,
        settledKeys: [...settledKeys],
      }
    },
    saveEvalRunDrive: async (input: {
      driveState: EvalDriveState
      release?: boolean
    }) => {
      state = input.driveState
      saves.push({ release: input.release, state: input.driveState })
      return { ok: true as const }
    },
    startEvalRun: async ({ rowId }) => ({ wfRunId: `run_${rowId}` }),
    getRunStatuses: async (ids) => {
      return Object.fromEntries(ids.map((id) => [id, {
        status: opts.cellsFinish ? 'done' : 'running',
        error: null,
      }])) as never},
    gradeEvalResult: async ({ rowId }) => {
      graded.push(rowId)
      settledKeys.push(evalCellKey({ rowId }))
      return {} as never
    },
    recordEvalFailure: async ({ rowId }) => {
      settledKeys.push(evalCellKey({ rowId }))
      return {} as never
    },
    ...over,
  })
  return { client, saves, graded, reads }
}

describe('driveEvalRun — handing off', () => {
  test('releases the run when it stops with cells left', async () => {
    const { client, saves } = driveHarness(4)

    // budgetMs 0 is "one tick" — what a request-bound caller like the MCP
    // endpoint gets, since it cannot outlive its own response.
    const out = await driveEvalRun(client, 'er_1', { budgetMs: 0 })
    expect(out.done).toBe(false)
    expect(saves).toHaveLength(1)
    expect(saves[0].release).toBe(true)
    // The cell it started is written down, so whoever adopts the run next polls
    // it instead of starting it again.
    expect(saves[0].state.inflight).toHaveLength(1)
  })

  // Every started cell lands immediately, so a 2-cell sweep at concurrency 1
  // completes across two ticks without the budget ever being consulted.
  test('does not release while it is still driving', async () => {
    const { client, saves, graded } = driveHarness(
      2,
      { cellsFinish: true },
      { finalizeEvalRun: async () => ({}) as never },
    )
    const out = await driveEvalRun(client, 'er_1', { pollIntervalMs: 0 })
    expect(out.done).toBe(true)
    expect(graded).toEqual(['row_0', 'row_1'])
    expect(saves.every((s) => s.release !== true)).toBe(true)
  })

  test('finalizes once every cell has settled', async () => {
    let finalized = false
    const { client } = driveHarness(
      1,
      { cellsFinish: true },
      {
        finalizeEvalRun: async () => {
          finalized = true
          return {} as never
        },
      },
    )
    await driveEvalRun(client, 'er_1', { pollIntervalMs: 0 })
    expect(finalized).toBe(true)
  })

  test('stops without finalizing when another driver already finished it', async () => {
    let finalized = false
    const client = stubClient({
      getEvalRunDrive: async (evalRunId: string) => ({
        evalRunId,
        status: 'completed',
        plan: plan(4),
        driveState: EMPTY_DRIVE_STATE,
        settledKeys: [],
      }),
      finalizeEvalRun: async () => {
        finalized = true
        return {} as never
      },
    })
    const out = await driveEvalRun(client, 'er_1')
    expect(out.done).toBe(true)
    expect(finalized).toBe(false)
  })

  test('refuses a run that predates plans rather than looping on nothing', async () => {
    const client = stubClient({
      getEvalRunDrive: async (evalRunId: string) => ({
        evalRunId,
        status: 'queued',
        plan: null,
        driveState: EMPTY_DRIVE_STATE,
        settledKeys: [],
      }),
    })
    await expect(driveEvalRun(client, 'er_old')).rejects.toThrow(
      /predates resumable sweeps/,
    )
  })
})

describe('driveEvalRun — per-tick storage traffic', () => {
  test('reads the plan once, then only the mutable state', async () => {
    const { client, reads } = driveHarness(
      2,
      { cellsFinish: true },
      { finalizeEvalRun: async () => ({}) as never },
    )
    await driveEvalRun(client, 'er_1', { pollIntervalMs: 0 })
    expect(reads.length).toBeGreaterThan(1)
    expect(reads[0].withPlan).toBe(true)
    expect(reads.slice(1).every((r) => r.withPlan === false)).toBe(true)
  })

  // Cells never finish, concurrency 1: after the first tick starts row_0 every
  // later tick only re-polls it. Time steps 10s per tick, and the 60s budget
  // ends before the harness plan's 60s cell timeout could settle anything.
  test('skips the write on idle ticks but keeps the heartbeat fresh', async () => {
    let t = 0
    const { client, saves, reads } = driveHarness(4)
    const out = await driveEvalRun(client, 'er_1', {
      pollIntervalMs: 0,
      budgetMs: 60_000,
      now: () => t,
      onProgress: () => {
        t += 10_000
      },
    })
    expect(out.done).toBe(false)
    // Seven ticks (0s…60s), three writes: the start at 0s, the heartbeat at
    // 30s, and the hand-off at 60s.
    expect(reads).toHaveLength(7)
    expect(saves.map((s) => s.release === true)).toEqual([false, false, true])
  })
})
