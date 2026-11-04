import { describe, expect, test } from 'bun:test'

import type { WfDataClient } from '../server/protocol'

import { evalCellKey, type EvalPlan } from './plan'
import { MAX_CONSECUTIVE_CELL_ERRORS, runEvalSweep, type EvalSweepStep } from './sweep'

function plan(cells: number, over: Partial<EvalPlan> = {}): EvalPlan {
  return {
    version: 1,
    cells: Array.from({ length: cells }, (_, i) => ({ rowId: `row_${i}` })),
    mode: 'run',
    concurrency: 1,
    timeoutMs: 60_000,
    ...over,
  }
}

/**
 * A Workflows step with a real journal: a name it has seen returns what it
 * returned the first time, without running again. That is the behaviour a replay
 * depends on, so `replay` can run the same sweep twice over one journal.
 */
function fakeStep(args: { timesOut?: boolean } = {}) {
  const journal = new Map<string, unknown>()
  const names: string[] = []
  const step: EvalSweepStep = {
    do: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      if (journal.has(name)) return journal.get(name) as T
      names.push(name)
      const value = await fn()
      journal.set(name, value)
      return value
    },
    waitForEvent: async (name) => {
      names.push(name)
      if (args.timesOut) throw new Error('timed out')
      return null
    },
  }
  return { step, names }
}

type Harness = {
  runStatus?: (wfRunId: string) => { status: string; error: string | null }
  settledKeys?: string[]
  status?: string
  over?: Partial<WfDataClient>
}

function harness(cells: number, planOver: Partial<EvalPlan> = {}, h: Harness = {}) {
  const started: { rowId: string; sweepEvent?: string }[] = []
  const graded: string[] = []
  const failures: { rowId: string; error: string }[] = []
  let finalized = 0
  const thePlan = plan(cells, planOver)
  const client = {
    getEvalRunDrive: async (evalRunId: string, o?: { withPlan?: boolean }) => ({
      evalRunId,
      status: h.status ?? 'running',
      plan: o?.withPlan === false ? null : thePlan,
      settledKeys: h.settledKeys ?? [],
    }),
    startEvalRun: async (input: { rowId: string; sweepEvent?: string }) => {
      started.push(input)
      return { wfRunId: `run_${input.rowId}` }
    },
    getRunStatuses: async (ids: string[]) => {
      return Object.fromEntries(ids.map((id) => [
        id,
        h.runStatus?.(id) ?? { status: 'done', error: null },
      ]))
    },
    gradeEvalResult: async (input: { rowId: string }) => {
      graded.push(input.rowId)
      return {}
    },
    recordEvalFailure: async (input: { rowId: string; error: string }) => {
      failures.push(input)
      return {}
    },
    finalizeEvalRun: async () => {
      finalized += 1
      return {}
    },
    ...h.over,
  } as unknown as WfDataClient
  return {
    client,
    started,
    graded,
    failures,
    finalized: () => finalized,
  }
}

function sweep(client: WfDataClient, step: EvalSweepStep) {
  return runEvalSweep(client, step, { evalRunId: 'er_1' })
}

describe('runEvalSweep — running cells', () => {
  test('starts, waits for and grades every cell, then finalizes once', async () => {
    const h = harness(3)
    const { step, names } = fakeStep()
    await sweep(h.client, step)
    expect(h.graded).toEqual(['row_0', 'row_1', 'row_2'])
    expect(h.failures).toEqual([])
    expect(h.finalized()).toBe(1)
    // Three steps per cell is what keeps a sweep well inside the step cap.
    expect(names).toEqual([
      'load',
      'start:0', 'await:0', 'grade:0',
      'start:1', 'await:1', 'grade:1',
      'start:2', 'await:2', 'grade:2',
      'finalize',
    ])
  })

  test('never has more cells in flight than the plan’s concurrency', async () => {
    let inFlight = 0
    let peak = 0
    const h = harness(6, { concurrency: 2 })
    const { step } = fakeStep()
    await sweep(h.client, {
      ...step,
      waitForEvent: async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 1))
        inFlight -= 1
        return null
      },
    })
    expect(peak).toBe(2)
    expect(h.graded).toHaveLength(6)
  })

  test('gives each started run its own wake-up event', async () => {
    const h = harness(2)
    await sweep(h.client, fakeStep().step)
    const events = h.started.map((s) => s.sweepEvent)
    expect(events.every((e) => /^[A-Z0-9-]{1,100}$/i.test(e ?? ''))).toBe(true)
    expect(new Set(events).size).toBe(2)
  })

  test('skips a cell that already has a verdict, as a restarted sweep must', async () => {
    const h = harness(3, {}, { settledKeys: [evalCellKey({ rowId: 'row_1' })] })
    await sweep(h.client, fakeStep().step)
    expect(h.started.map((s) => s.rowId)).toEqual(['row_0', 'row_2'])
  })

  test('accepts `completed` as well as `done`', async () => {
    const h = harness(1, {}, {
      runStatus: () => ({ status: 'completed', error: null }),
    })
    await sweep(h.client, fakeStep().step)
    expect(h.graded).toEqual(['row_0'])
  })

  test('a replay re-executes nothing the journal already has', async () => {
    const h = harness(3, { concurrency: 2 })
    const { step } = fakeStep()
    await sweep(h.client, step)
    const startedOnce = h.started.length
    await sweep(h.client, step)
    expect(h.started).toHaveLength(startedOnce)
    expect(h.graded).toHaveLength(3)
    expect(h.finalized()).toBe(1)
  })

  test('finalizes a plan with no cells', async () => {
    const h = harness(0)
    await sweep(h.client, fakeStep().step)
    expect(h.finalized()).toBe(1)
  })

  test('refuses a run with no plan', async () => {
    const h = harness(1, {}, {
      over: {
        getEvalRunDrive: async (evalRunId: string) => ({
          evalRunId,
          status: 'queued',
          plan: null,
          settledKeys: [],
        }),
      },
    })
    await expect(sweep(h.client, fakeStep().step)).rejects.toThrow(
      /predates resumable sweeps/,
    )
  })
})

describe('runEvalSweep — a cell that does not pass', () => {
  test('a finished run whose wake-up was lost is still graded after the timeout', async () => {
    const h = harness(1)
    await sweep(h.client, fakeStep({ timesOut: true }).step)
    expect(h.graded).toEqual(['row_0'])
    expect(h.failures).toEqual([])
  })

  test('a run still going at the timeout is recorded, without tripping the breaker', async () => {
    const cells = MAX_CONSECUTIVE_CELL_ERRORS + 2
    const h = harness(cells, {}, {
      runStatus: () => ({ status: 'running', error: null }),
    })
    await sweep(h.client, fakeStep({ timesOut: true }).step)
    expect(h.started).toHaveLength(cells)
    expect(h.failures.every((f) => /still executing/.test(f.error))).toBe(true)
  })

  test('records a failed run instead of grading it', async () => {
    const h = harness(1, {}, {
      runStatus: () => ({ status: 'failed', error: 'The provider said no.' }),
    })
    await sweep(h.client, fakeStep().step)
    expect(h.graded).toEqual([])
    expect(h.failures.map((f) => [f.rowId, f.error])).toEqual([
      ['row_0', 'The provider said no.'],
    ])
  })

  test('records a cell whose start was refused, and carries on', async () => {
    const h = harness(2, {}, {
      over: {
        startEvalRun: async (input: { rowId: string }) => {
          if (input.rowId === 'row_0') {
            throw new Error('The playground’s client must be in a firm you staff')
          }
          return { wfRunId: `run_${input.rowId}` }
        },
      },
    })
    await sweep(h.client, fakeStep().step)
    expect(h.failures.map((f) => f.rowId)).toEqual(['row_0'])
    expect(h.graded).toEqual(['row_1'])
    expect(h.finalized()).toBe(1)
  })

  test('records a judge failure as a cell with no verdict', async () => {
    const h = harness(1, {}, {
      over: {
        gradeEvalResult: async () => {
          throw new Error('The judge fell over.')
        },
      },
    })
    await sweep(h.client, fakeStep().step)
    expect(h.failures.map((f) => f.error)).toEqual(['The judge fell over.'])
  })

  test('a failed write fails the step, so nothing vanishes from the totals', async () => {
    const h = harness(1, {}, {
      runStatus: () => ({ status: 'failed', error: 'no' }),
      over: {
        recordEvalFailure: async () => {
          throw new Error('D1 blipped')
        },
      },
    })
    await expect(sweep(h.client, fakeStep().step)).rejects.toThrow('D1 blipped')
    expect(h.finalized()).toBe(0)
  })
})

describe('runEvalSweep — the circuit breaker', () => {
  test('latches after consecutive failures and records the rest as skips', async () => {
    const h = harness(6, {}, {
      runStatus: () => ({ status: 'failed', error: 'down' }),
    })
    await sweep(h.client, fakeStep().step)
    expect(h.started).toHaveLength(MAX_CONSECUTIVE_CELL_ERRORS)
    expect(h.failures).toHaveLength(6)
    expect(h.failures.filter((f) => f.error.startsWith('Skipped'))).toHaveLength(3)
    expect(h.finalized()).toBe(1)
  })

  test('a success clears the tally', async () => {
    const h = harness(5, {}, {
      runStatus: (id) => ({
        status: id === 'run_row_2' ? 'done' : 'failed',
        error: id === 'run_row_2' ? null : 'down',
      }),
    })
    await sweep(h.client, fakeStep().step)
    expect(h.started).toHaveLength(5)
    expect(h.failures.some((f) => f.error.startsWith('Skipped'))).toBe(false)
  })
})

describe('runEvalSweep — cancelling', () => {
  test('starts nothing and does not finalize a cancelled run', async () => {
    const h = harness(3, {}, { status: 'cancelled' })
    await sweep(h.client, fakeStep().step)
    expect(h.started).toEqual([])
    expect(h.finalized()).toBe(0)
  })

  test('stops launching once cancelled, but grades the cell already going', async () => {
    let status = 'running'
    const h = harness(3)
    const client = {
      ...h.client,
      getEvalRunDrive: async (evalRunId: string, o?: { withPlan?: boolean }) => ({
        ...(await h.client.getEvalRunDrive(evalRunId, o)),
        status,
      }),
    } as WfDataClient
    const { step } = fakeStep()
    await sweep(client, {
      ...step,
      waitForEvent: async () => {
        status = 'cancelled'
        return null
      },
    })
    expect(h.started.map((s) => s.rowId)).toEqual(['row_0'])
    expect(h.graded).toEqual(['row_0'])
    expect(h.finalized()).toBe(0)
  })
})

describe('runEvalSweep — a decision sweep', () => {
  test('settles each cell in its start step, without ever starting a run', async () => {
    const ran: string[] = []
    const h = harness(2, { mode: 'decision' }, {
      over: {
        runDecisionEvalCell: async (input: { rowId: string }) => {
          ran.push(input.rowId)
          return {} as never
        },
      },
    })
    const { step, names } = fakeStep()
    await sweep(h.client, step)
    expect(ran).toEqual(['row_0', 'row_1'])
    expect(h.started).toEqual([])
    expect(names.some((n) => n.startsWith('await:'))).toBe(false)
    expect(h.finalized()).toBe(1)
  })

  test('a refusing provider trips the same breaker', async () => {
    let calls = 0
    const h = harness(5, { mode: 'decision' }, {
      over: {
        runDecisionEvalCell: async () => {
          calls += 1
          throw new Error('429')
        },
      },
    })
    await sweep(h.client, fakeStep().step)
    expect(calls).toBe(MAX_CONSECUTIVE_CELL_ERRORS)
    expect(h.failures).toHaveLength(5)
  })
})
