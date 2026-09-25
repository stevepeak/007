import { describe, expect, test } from 'bun:test'

import { EMPTY_DRIVE_STATE, parseEvalPlan } from '../eval/plan'
import type {
  WfDataClient,
  WfEvalResultDTO,
  WfEvalRunDetail,
} from '../server/protocol'

import type { WfMcpTool } from './tools'
import { evalRunReadTools, evalRunWriteTools } from './tools-eval-runs'

/**
 * The two things a report must not let a model conclude: that an outage was a
 * regression (`error` vs `fail`), and that a moved pass rate was the agent when
 * it was the test — or the reverse. Everything else here is bounding: a tool
 * call that can launch four hundred real model calls needs a wall in front of
 * it.
 */

function toolNamed(name: string): WfMcpTool {
  const found = [...evalRunReadTools(), ...evalRunWriteTools()].find(
    (t) => t.name === name,
  )
  if (!found) throw new Error(`no such tool: ${name}`)
  return found
}

function stubClient(partial: Partial<WfDataClient>): WfDataClient {
  return partial as WfDataClient
}

/**
 * The drive half of a stub client.
 *
 * `run_eval` no longer fires a sweep off into the background — it creates the
 * run WITH its plan and drives one tick before answering, so the plan has to be
 * readable back for anything to launch at all. This stubs that round trip in
 * memory: whatever `createEvalRun` was handed comes back out of
 * `getEvalRunDrive`, with nothing settled and nothing in flight.
 */
function driveStubs(over: Partial<WfDataClient> = {}): Partial<WfDataClient> {
  let plan: unknown = null
  return {
    createEvalRun: async (input: { plan?: unknown }) => {
      plan = input.plan
      return { evalRunId: 'er_1' }
    },
    getEvalRunDrive: async (evalRunId: string) => ({
      evalRunId,
      status: 'queued',
      plan: parseEvalPlan(plan),
      driveState: EMPTY_DRIVE_STATE,
      settledKeys: [],
    }),
    saveEvalRunDrive: async () => ({ ok: true as const }),
    ...over,
  }
}

function result(over: Partial<WfEvalResultDTO>): WfEvalResultDTO {
  return {
    id: 'res_1',
    evalRunId: 'er_1',
    rowId: 'row_1',
    wfRunId: 'run_1',
    runStats: null,
    status: 'pass',
    score: null,
    checkResults: [],
    error: null,
    snapshot: null,
    snapshotHash: null,
    previousSnapshotHash: null,
    modelId: null,
    promptLabel: null,
    promptBody: null,
    attempt: null,
    createdAt: 1,
    ...over,
  }
}

function detail(over: {
  results: WfEvalResultDTO[]
  total?: number
  status?: string
  score?: number | null
  drift?: WfEvalRunDetail['drift']
}): WfEvalRunDetail {
  return {
    run: {
      id: 'er_1',
      status: over.status ?? 'completed',
      setIds: ['set_1'],
      total: over.total ?? over.results.length,
      passed: over.results.filter((r) => r.status === 'pass').length,
      failed: over.results.filter((r) => r.status === 'fail').length,
      score: over.score ?? null,
      createdAt: 1,
      startedAt: 1,
      finishedAt: 2,
    },
    results: over.results,
    drift: over.drift ?? null,
  }
}

/** A snapshot carrying just the fields the report reads off it. */
function snapshot(name: string, checks: unknown[]) {
  return {
    row: {
      name,
      description: null,
      input: {},
      tools: {},
      checks: { op: 'and', checks },
    },
    target: {},
  } as never
}

describe('get_eval_run — error is not fail', () => {
  test('counts errors apart and computes the pass rate over graded cells only', async () => {
    const client = stubClient({
      getEvalRun: async () => {
        return detail({
          results: [
            result({ rowId: 'a', status: 'pass' }),
            result({ rowId: 'b', status: 'fail' }),
            result({
              rowId: 'c',
              status: 'error',
              error: 'The run ended as "failed".',
            }),
            result({ rowId: 'd', status: 'error', error: 'Provider 429' }),
          ],
        })
      },
    })
    const out = (await toolNamed('get_eval_run').run(client, {
      evalRunId: 'er_1',
    })) as {
      summary: {
        passed: number
        failed: number
        errored: number
        graded: number
        passRate: number | null
      }
      errors: { rowId: string; error: string }[]
    }
    expect(out.summary).toMatchObject({
      passed: 1,
      failed: 1,
      errored: 2,
      graded: 2,
    })
    // 1/2, NOT 1/4. Over `total` a provider outage reads as the agent
    // regressing, which is the one misreading this report must not allow.
    expect(out.summary.passRate).toBe(0.5)
    expect(out.errors.map((e) => e.rowId).sort()).toEqual(['c', 'd'])
    expect(out.errors.map((e) => e.error)).toContain('Provider 429')
  })

  // The stored summary counts `failed` as `total - passed`, so an errored cell
  // is a failure there. Passing that object through would hand the model two
  // contradictory numbers and no way to know which one to believe.
  test('does not pass the stored run summary’s conflated counts through', async () => {
    const client = stubClient({
      getEvalRun: async () => {
        return detail({
          results: [result({ rowId: 'a', status: 'error', error: 'boom' })],
        })
      },
    })
    const out = (await toolNamed('get_eval_run').run(client, {
      evalRunId: 'er_1',
    })) as { run: Record<string, unknown> }
    expect(out.run).not.toHaveProperty('failed')
    expect(out.run).not.toHaveProperty('passed')
    expect(out.run.status).toBe('completed')
    expect(out.run.goalIds).toEqual(['set_1'])
  })

  test('a run of nothing but errors reports no pass rate, not zero', async () => {
    const client = stubClient({
      getEvalRun: async () => {
        return detail({
          results: [
            result({ rowId: 'a', status: 'error', error: 'boom' }),
            result({ rowId: 'b', status: 'error', error: 'boom' }),
          ],
        })
      },
    })
    const out = (await toolNamed('get_eval_run').run(client, {
      evalRunId: 'er_1',
    })) as { summary: { passRate: number | null; errored: number } }
    expect(out.summary.passRate).toBeNull()
    expect(out.summary.errored).toBe(2)
  })

  test('counts cells that have not reported yet as pending', async () => {
    const client = stubClient({
      getEvalRun: async () => {
        return detail({
          status: 'running',
          total: 10,
          results: [result({ rowId: 'a', status: 'pass' })],
        })
      },
    })
    const out = (await toolNamed('get_eval_run').run(client, {
      evalRunId: 'er_1',
    })) as { summary: { pending: number } }
    expect(out.summary.pending).toBe(9)
  })
})

describe('get_eval_run — what a check actually asserted', () => {
  test('zips verdicts onto the snapshot checks by position', async () => {
    const client = stubClient({
      getEvalRun: async () => {
        return detail({
          results: [
            result({
              rowId: 'a',
              status: 'fail',
              snapshot: snapshot('Refuses a conflicted matter', [
                { type: 'tool_called', toolId: 'search_clients', called: true },
                { type: 'llm_judge', rubric: 'Declines to advise.' },
              ]),
              checkResults: [
                { pass: true },
                {
                  pass: false,
                  confidence: 8,
                  reason: 'It gave advice anyway.',
                },
              ],
            }),
          ],
        })
      },
    })
    const out = (await toolNamed('get_eval_run').run(client, {
      evalRunId: 'er_1',
    })) as {
      results: {
        sample: string
        checks: {
          type: string
          pass: boolean
          reason?: string
          check?: unknown
        }[]
      }[]
    }
    const row = out.results[0]
    expect(row.sample).toBe('Refuses a conflicted matter')
    // A binary check has no `reason`; without its config a failing one says only
    // `false`, which is not a finding anyone can act on.
    expect(row.checks[0]).toMatchObject({ type: 'tool_called', pass: true })
    expect(row.checks[0].check).toMatchObject({ toolId: 'search_clients' })
    expect(row.checks[1]).toMatchObject({
      type: 'llm_judge',
      pass: false,
      reason: 'It gave advice anyway.',
    })
  })

  test('survives a result graded before snapshots existed', async () => {
    const client = stubClient({
      getEvalRun: async () => {
        return detail({
          results: [
            result({
              rowId: 'a',
              status: 'fail',
              checkResults: [{ pass: false }],
            }),
          ],
        })
      },
    })
    const out = (await toolNamed('get_eval_run').run(client, {
      evalRunId: 'er_1',
    })) as { results: { sample: string; checks: { type: string }[] }[] }
    expect(out.results[0].sample).toBe('a')
    expect(out.results[0].checks[0].type).toBe('unknown')
  })
})

describe('get_eval_run — drift has two axes', () => {
  test('separates an edited sample from a republished agent', async () => {
    const client = stubClient({
      getEvalRun: async () => {
        return detail({
          results: [
            result({
              rowId: 'a',
              status: 'fail',
              snapshotHash: 'h2',
              previousSnapshotHash: 'h1',
              runStats: {
                totalTokens: 10,
                costUsd: 0.1,
                models: ['x'],
                durationMs: 5,
                agentVersion: 7,
              },
            }),
          ],
          drift: {
            previousRunId: 'er_0',
            previousRunAt: 1,
            previousAgentVersion: 6,
            goalChanges: [],
            targetChanges: [],
          },
        })
      },
    })
    const out = (await toolNamed('get_eval_run').run(client, {
      evalRunId: 'er_1',
    })) as {
      drift: {
        samplesEdited: boolean
        agentRepublishedSinceLastRun: boolean
        previousAgentVersion: number
        agentVersionsThisRun: number[]
      }
      results: { sampleEditedSinceLastRun: boolean }[]
    }
    expect(out.drift.samplesEdited).toBe(true)
    // The axis `previousSnapshotHash` is structurally blind to.
    expect(out.drift.agentRepublishedSinceLastRun).toBe(true)
    expect(out.drift.agentVersionsThisRun).toEqual([7])
    expect(out.results[0].sampleEditedSinceLastRun).toBe(true)
  })

  test('an unchanged sample on an unchanged agent moves neither axis', async () => {
    const client = stubClient({
      getEvalRun: async () => {
        return detail({
          results: [
            result({
              rowId: 'a',
              snapshotHash: 'h1',
              previousSnapshotHash: 'h1',
              runStats: {
                totalTokens: null,
                costUsd: null,
                models: [],
                durationMs: null,
                agentVersion: 6,
              },
            }),
          ],
          drift: {
            previousRunId: 'er_0',
            previousRunAt: 1,
            previousAgentVersion: 6,
            goalChanges: [],
            targetChanges: [],
          },
        })
      },
    })
    const out = (await toolNamed('get_eval_run').run(client, {
      evalRunId: 'er_1',
    })) as {
      drift: { samplesEdited: boolean; agentRepublishedSinceLastRun: boolean }
    }
    expect(out.drift.samplesEdited).toBe(false)
    expect(out.drift.agentRepublishedSinceLastRun).toBe(false)
  })

  test('says so when there is no comparable earlier run', async () => {
    const client = stubClient({
      getEvalRun: async () => detail({ results: [result({})] }),
    })
    const out = (await toolNamed('get_eval_run').run(client, {
      evalRunId: 'er_1',
    })) as { drift: { previousRun: null; note: string } }
    expect(out.drift.previousRun).toBeNull()
    expect(out.drift.note).toContain('nothing to compare')
  })
})

describe('get_eval_run — bounding a matrix report', () => {
  test('truncates worst-first, so failures survive and passes are dropped', async () => {
    const results = [
      ...Array.from({ length: 80 }, (_, i) => {
        return result({ id: `p${i}`, rowId: `p${i}`, status: 'pass' })
      }),
      result({ id: 'f1', rowId: 'f1', status: 'fail' }),
      result({ id: 'e1', rowId: 'e1', status: 'error', error: 'boom' }),
    ]
    const client = stubClient({ getEvalRun: async () => detail({ results }) })
    const out = (await toolNamed('get_eval_run').run(client, {
      evalRunId: 'er_1',
    })) as { results: { rowId: string; status: string }[]; note: string }
    expect(out.results.length).toBe(60)
    expect(out.results[0].status).toBe('error')
    expect(out.results[1].status).toBe('fail')
    expect(out.results.map((r) => r.rowId)).toContain('f1')
    expect(out.note).toContain('82')
    // The counts above the list are always complete, truncation or not.
  })

  test('rowId drills into one sample and returns every cell of it', async () => {
    const client = stubClient({
      getEvalRun: async () => {
        return detail({
          results: [
            result({ rowId: 'a', modelId: 'm1', promptLabel: 'P', attempt: 0 }),
            result({ rowId: 'a', modelId: 'm2', promptLabel: 'P', attempt: 0 }),
            result({ rowId: 'b' }),
          ],
        })
      },
    })
    const out = (await toolNamed('get_eval_run').run(client, {
      evalRunId: 'er_1',
      rowId: 'a',
    })) as {
      results: { cell: { modelId: string } }[]
      summary: { passed: number }
    }
    expect(out.results.length).toBe(2)
    expect(out.results.map((r) => r.cell.modelId).sort()).toEqual(['m1', 'm2'])
    // The roll-up stays over the WHOLE run — drilling in must not change what
    // the run's pass rate was.
    expect(out.summary.passed).toBe(3)
  })

  test('omits the cell block entirely on a plain (non-matrix) run', async () => {
    const client = stubClient({
      getEvalRun: async () => detail({ results: [result({ rowId: 'a' })] }),
    })
    const out = (await toolNamed('get_eval_run').run(client, {
      evalRunId: 'er_1',
    })) as { results: { cell?: unknown }[] }
    expect(out.results[0].cell).toBeUndefined()
  })

  test('names the samples it does have when rowId matches none', async () => {
    const client = stubClient({
      getEvalRun: async () => detail({ results: [result({ rowId: 'a' })] }),
    })
    const out = (await toolNamed('get_eval_run').run(client, {
      evalRunId: 'er_1',
      rowId: 'nope',
    })) as { error: string; sampleIds: string[] }
    expect(out.error).toContain('no results for sample nope')
    expect(out.sampleIds).toEqual(['a'])
  })

  test('a missing run is an answer, not a throw', async () => {
    const client = stubClient({ getEvalRun: async () => null })
    const out = (await toolNamed('get_eval_run').run(client, {
      evalRunId: 'er_x',
    })) as { error: string }
    expect(out.error).toContain('No eval run found')
  })
})

describe('run_eval — bounding the sweep', () => {
  const setWith = (rows: number) => ({
    set: { id: 'set_1', name: 'Goal', targetKind: 'agent', targetId: 'ag_1' },
    rows: Array.from({ length: rows }, (_, i) => ({
      id: `row_${i}`,
      archived: false,
    })),
  })

  /**
   * A catalog the gate can read. Every named model has to EXIST before the cell
   * arithmetic is even reached now — an id that isn't in the catalog would fail
   * at the provider in every cell of its column and read as an outage.
   */
  const catalogStubs = (
    ids: string[] = ['a', 'b', 'c'],
  ): Partial<WfDataClient> => ({
    listModels: async () => { return ids.map((id) => ({
        id,
        label: id,
        capabilities: {
          tools: true,
          structuredOutput: true,
          reasoning: true,
          webSearch: true,
        },
      })) },
    listAgents: async () => [] as never,
  })

  test('refuses a sweep over the cell cap and launches nothing', async () => {
    let created = false
    const client = stubClient({
      ...catalogStubs(),
      getEvalSet: async () => setWith(20) as never,
      createEvalRun: async () => {
        created = true
        return { evalRunId: 'er_1' }
      },
    })
    const out = (await toolNamed('run_eval').run(client, {
      setIds: ['set_1'],
      models: ['a', 'b', 'c'],
      attempts: 3,
    })) as { error: string }
    // 20 samples × 3 models × 3 attempts = 180 real model calls.
    expect(out.error).toContain('180')
    expect(out.error).toContain('cap is 100')
    expect(created).toBe(false)
  })

  test('counts prompt variations as columns, baseline included', async () => {
    const client = stubClient({
      ...driveStubs(),
      ...catalogStubs(),
      getEvalSet: async () => setWith(30) as never,
      // Started cells never reach a terminal status, so the assertion is about
      // the arithmetic rather than about a sweep of sixty stubbed runs
      // finishing. Only the first tick's worth actually start.
      startEvalRun: async () => ({ wfRunId: 'run_1' }),
      getRunStatus: async () => ({ status: 'running', error: null }) as never,
      finalizeEvalRun: async () => ({}) as never,
    })
    const out = (await toolNamed('run_eval').run(client, {
      setIds: ['set_1'],
      models: ['a'],
      prompts: [{ label: 'Terser', body: 'Be terse.' }],
    })) as { launched: { cellsPerSample: number; totalRuns: number } }
    // 1 model × (the target's saved prompt + 1 variation) = 2 columns.
    expect(out.launched.cellsPerSample).toBe(2)
    expect(out.launched.totalRuns).toBe(60)
  })

  test('archived samples do not count toward the sweep', async () => {
    const client = stubClient({
      getEvalSet: async () => {
        return {
          set: { id: 'set_1', name: 'Goal' },
          rows: [
            { id: 'row_0', archived: false },
            { id: 'row_1', archived: true },
          ],
        } as never
      },
      ...driveStubs(),
      startEvalRun: async () => ({ wfRunId: 'run_1' }),
      getRunStatus: async () => ({ status: 'running', error: null }) as never,
      gradeEvalResult: async () => ({}) as never,
      finalizeEvalRun: async () => ({}) as never,
    })
    const out = (await toolNamed('run_eval').run(client, {
      setIds: ['set_1'],
    })) as { launched: { samples: number } }
    expect(out.launched.samples).toBe(1)
  })

  test('refuses a goal with no samples rather than finalizing an empty report', async () => {
    const client = stubClient({
      getEvalSet: async () => ({ set: { id: 'set_1' }, rows: [] }) as never,
    })
    const out = (await toolNamed('run_eval').run(client, {
      setIds: ['set_1'],
    })) as { error: string }
    expect(out.error).toContain('no samples')
  })

  test('names a goal id that does not exist', async () => {
    const client = stubClient({ getEvalSet: async () => null })
    const out = (await toolNamed('run_eval').run(client, {
      setIds: ['nope'],
    })) as { error: string }
    expect(out.error).toContain('No eval goal found for id nope')
  })

  test('rejects prompt variations with no model to run them on', async () => {
    const client = stubClient({ getEvalSet: async () => setWith(1) as never })
    // Without a model the matrix expands to zero cells and `runEval` would
    // finalize an empty report that looks like a clean pass.
    await expect(
      toolNamed('run_eval').run(client, {
        setIds: ['set_1'],
        prompts: [{ label: 'Terser', body: 'Be terse.' }],
      }),
    ).rejects.toThrow(/at least one entry in `models`/)
  })

  test('requires setIds', async () => {
    await expect(
      toolNamed('run_eval').run(stubClient({}), { setIds: [] }),
    ).rejects.toThrow(/setIds/)
  })
})

describe('run_eval — returning before the sweep finishes', () => {
  test('answers once the first cells are launched, not on completion', async () => {
    let finalized = false
    let starts = 0
    const client = stubClient({
      ...driveStubs(),
      getEvalSet: async () => {
        return {
          set: { id: 'set_1' },
          rows: Array.from({ length: 6 }, (_, i) => ({
            id: `row_${i}`,
            archived: false,
          })),
        } as never
      },
      startEvalRun: async () => {
        starts += 1
        return { wfRunId: `run_${starts}` }
      },
      // Nothing the first tick started has finished yet — which is the normal
      // case for a sweep whose cells take minutes.
      getRunStatus: async () => ({ status: 'running', error: null }) as never,
      gradeEvalResult: async () => ({}) as never,
      finalizeEvalRun: async () => {
        finalized = true
        return {} as never
      },
    })
    const out = (await toolNamed('run_eval').run(client, {
      setIds: ['set_1'],
      concurrency: 2,
    })) as { evalRunId: string; next: string; launched: { totalRuns: number } }
    expect(out.evalRunId).toBe('er_1')
    // One tick's worth of cells, not all six: the rest are the backstop's.
    expect(starts).toBe(2)
    expect(out.launched.totalRuns).toBe(6)
    expect(finalized).toBe(false)
    expect(out.next).toContain('get_eval_run')
  })

  // The old contract was that the tool fired the sweep into the background and
  // returned. That silently stopped working when this endpoint became a Worker
  // request: the background work was cancelled with the request context, and
  // every MCP-launched run sat at `queued` with no error anywhere. What the
  // caller is promised now is that the run is DRIVABLE without it.
  test('leaves the rest of the sweep to the server, not to this session', async () => {
    const client = stubClient({
      ...driveStubs(),
      getEvalSet: async () => {
        return {
          set: { id: 'set_1' },
          rows: [{ id: 'row_0', archived: false }],
        } as never
      },
      startEvalRun: async () => ({ wfRunId: 'run_1' }),
      getRunStatus: async () => ({ status: 'running', error: null }) as never,
      finalizeEvalRun: async () => ({}) as never,
    })
    const out = (await toolNamed('run_eval').run(client, {
      setIds: ['set_1'],
    })) as { next: string }
    expect(out.next).toContain('runs on the server')
  })

  test('a failure BEFORE the run row exists still reaches the caller', async () => {
    const client = stubClient({
      getEvalSet: async () => {
        return {
          set: { id: 'set_1' },
          rows: [{ id: 'row_0', archived: false }],
        } as never
      },
      createEvalRun: async () => {
        throw new Error('Invalid service token')
      },
    })
    await expect(
      toolNamed('run_eval').run(client, { setIds: ['set_1'] }),
    ).rejects.toThrow('Invalid service token')
  })
})

describe('list_eval_runs', () => {
  test('names the goals a run covered', async () => {
    const client = stubClient({
      listEvalRuns: async () => {
        return [{ id: 'er_1', setIds: ['set_1', 'gone'] }] as never
      },
      listEvalSets: async () => {
        return [{ id: 'set_1', name: 'Conflict check' }] as never
      },
    })
    const out = (await toolNamed('list_eval_runs').run(client, {})) as {
      goals: string[]
    }[]
    expect(out[0].goals).toEqual(['Conflict check', 'gone'])
  })

  test('renames the conflated `failed` rather than passing it through', async () => {
    const client = stubClient({
      listEvalRuns: async () => {
        return [
          { id: 'er_1', setIds: [], passed: 1, failed: 3, score: 0.5 },
        ] as never
      },
      listEvalSets: async () => [],
    })
    const out = (await toolNamed('list_eval_runs').run(client, {})) as {
      passed: number
      notPassed: number
      failed?: number
    }[]
    // 3 of those may be errors; only get_eval_run can say which.
    expect(out[0].notPassed).toBe(3)
    expect(out[0].passed).toBe(1)
    expect(out[0]).not.toHaveProperty('failed')
  })

  test('still returns history when the goal lookup fails', async () => {
    const client = stubClient({
      listEvalRuns: async () => [{ id: 'er_1', setIds: ['set_1'] }] as never,
      listEvalSets: async () => {
        throw new Error('nope')
      },
    })
    const out = (await toolNamed('list_eval_runs').run(client, {})) as {
      id: string
    }[]
    expect(out[0].id).toBe('er_1')
  })
})

describe('run_eval — grading an unsaved draft', () => {
  const agentSet = (targetId: string, name = 'Goal') => {
    return {
      set: { id: 'set_1', name, rowCount: 1, targetKind: 'agent', targetId },
      rows: [{ id: 'row_0', archived: false }],
    } as never
  }

  const draftConfig = { prompt: 'Be very brief.' }

  function stub(over: Partial<WfDataClient> = {}): {
    started: Record<string, unknown>[]
    client: WfDataClient
  } {
    const started: Record<string, unknown>[] = []
    return {
      started,
      client: stubClient({
        getEvalSet: async () => agentSet('a1'),
        getAgent: async () => {
          return {
            agent: { id: 'a1' },
            draft: { config: draftConfig },
            currentVersion: { id: 'v1', versionNumber: 1, config: {} },
          } as never
        },
        ...driveStubs(),
        startEvalRun: async (input) => {
          started.push(input)
          return { wfRunId: 'run_1' }
        },
        // The launched cell never settles, so the tool answers after its first
        // tick and the assertions are about what it started, not what it graded.
        getRunStatus: async () => ({ status: 'running', error: null }) as never,
        finalizeEvalRun: async () => ({}) as never,
        ...over,
      }),
    }
  }

  test('rides the draft config onto every cell', async () => {
    const { started, client } = stub()
    const out = (await toolNamed('run_eval').run(client, {
      setIds: ['set_1'],
      draftAgentId: 'a1',
    })) as { launched: { target: string } }
    expect(started[0]?.config).toEqual(draftConfig)
    // A draft run and a published run look identical in the report afterwards,
    // so which one this was gets said on the way out.
    expect(out.launched.target).toContain('draft')
  })

  // The guard the UI can't need and a tool call can: the server applies the
  // override to every cell without checking WHOSE config it is, so one stray
  // setId would grade agent A's draft against agent B's samples and file the
  // result under B — passing, plausibly, and about nothing.
  test('refuses a goal that targets a different agent', async () => {
    const { started, client } = stub({
      getEvalSet: async () => agentSet('a2', 'Conflicts'),
    })
    const out = (await toolNamed('run_eval').run(client, {
      setIds: ['set_1'],
      draftAgentId: 'a1',
    })) as { error: string }
    expect(out.error).toContain('Conflicts')
    expect(started).toHaveLength(0)
  })

  test('refuses a goal that targets a workflow rather than an agent', async () => {
    const { started, client } = stub({
      getEvalSet: async () => {
        return {
          set: {
            id: 'set_1',
            name: 'Intake end to end',
            rowCount: 1,
            targetKind: 'workflow',
            targetId: 'a1',
          },
          rows: [{ id: 'row_0', archived: false }],
        } as never
      },
    })
    const out = (await toolNamed('run_eval').run(client, {
      setIds: ['set_1'],
      draftAgentId: 'a1',
    })) as { error: string }
    expect(out.error).toContain('Intake end to end')
    expect(started).toHaveLength(0)
  })

  test('says so rather than silently running the published version', async () => {
    const { started, client } = stub({
      getAgent: async () => {
        return {
          agent: { id: 'a1' },
          draft: null,
          currentVersion: null,
        } as never
      },
    })
    const out = (await toolNamed('run_eval').run(client, {
      setIds: ['set_1'],
      draftAgentId: 'a1',
    })) as { error: string }
    expect(out.error).toContain('no draft to override with')
    expect(started).toHaveLength(0)
  })

  // A draft row exists for nearly every agent and usually equals what was last
  // published, so "ran the draft" is a statement that is routinely accurate and
  // useless. A sweep launched to answer "did my edit help?" would otherwise
  // measure the live config and read as though it measured the edit.
  test('warns when the draft is identical to what is published', async () => {
    const { started, client } = stub({
      getAgent: async () => {
        return {
          agent: { id: 'a1' },
          draft: { config: draftConfig },
          currentVersion: { id: 'v1', versionNumber: 1, config: draftConfig },
        } as never
      },
    })
    const out = (await toolNamed('run_eval').run(client, {
      setIds: ['set_1'],
      draftAgentId: 'a1',
    })) as { launched: { unsavedFields: string[]; draftWarning: string } }
    // Not a refusal — the run is as valid as any other, it just answers a
    // different question than the caller thinks.
    expect(started).toHaveLength(1)
    expect(out.launched.unsavedFields).toEqual([])
    expect(out.launched.draftWarning).toContain('IDENTICAL')
  })

  test('names the fields a real edit changed', async () => {
    const { client } = stub()
    const out = (await toolNamed('run_eval').run(client, {
      setIds: ['set_1'],
      draftAgentId: 'a1',
    })) as { launched: { unsavedFields: string[]; draftWarning?: string } }
    expect(out.launched.unsavedFields).toEqual(['prompt'])
    expect(out.launched.draftWarning).toBeUndefined()
  })

  test('without draftAgentId nothing is overridden', async () => {
    const { started, client } = stub()
    const out = (await toolNamed('run_eval').run(client, {
      setIds: ['set_1'],
    })) as { launched: { target: string } }
    expect(started[0]?.config).toBeUndefined()
    expect(out.launched.target).toContain('published')
  })
})

describe('get_eval_run — the matrix roll-up', () => {
  /** A matrix cell's worth of results: {model × prompt} with cost + tokens. */
  const cell = (
    modelId: string,
    promptLabel: string,
    over: { status?: 'pass' | 'fail'; costUsd?: number; tokens?: number },
  ) => { return result({
      rowId: `row_${modelId}_${promptLabel}`,
      modelId,
      promptLabel,
      attempt: 0,
      status: over.status ?? 'pass',
      runStats: {
        totalTokens: over.tokens ?? 1000,
        costUsd: over.costUsd ?? 0.01,
        models: [modelId],
        durationMs: 1000,
        agentVersion: 3,
      },
    }) }

  const sweep = [
    cell('cheap', 'saved', { costUsd: 0.001, tokens: 2000 }),
    cell('pricey', 'saved', { costUsd: 0.05, tokens: 500 }),
    cell('pricey', 'terser', { costUsd: 0.05, status: 'fail' }),
  ]

  // A sweep's whole question. `run_eval` caps at 100 cells and this list is
  // bounded at 60, so before the roll-up "which model won?" was not merely
  // unaggregated — the answer could be outside the payload entirely.
  test('answers which cell won on accuracy, cost and speed', async () => {
    const client = stubClient({
      getEvalRun: async () => detail({ results: sweep }),
    })
    const out = (await toolNamed('get_eval_run').run(client, {
      evalRunId: 'er_1',
    })) as {
      matrix: {
        modelAxis: string[]
        promptAxis: string[]
        cells: { modelId: string; passed: number; total: number }[]
        bestAccuracy: string
        cheapest: string
        fastest: string
      }
    }
    expect(out.matrix.modelAxis).toEqual(['cheap', 'pricey'])
    expect(out.matrix.promptAxis).toEqual(['saved', 'terser'])
    expect(out.matrix.cells).toHaveLength(3)
    // Keys are `"<modelId> <promptLabel>"` — joinable back to the rows.
    expect(out.matrix.cheapest).toBe('cheap saved')
    // 2000 tokens in 1s beats 500 in 1s.
    expect(out.matrix.fastest).toBe('cheap saved')
    // The failing cell can't win accuracy.
    expect(out.matrix.bestAccuracy).not.toBe('pricey terser')
  })

  test('reports what the sweep spent', async () => {
    const client = stubClient({
      getEvalRun: async () => detail({ results: sweep }),
    })
    const out = (await toolNamed('get_eval_run').run(client, {
      evalRunId: 'er_1',
    })) as { cost: { totalUsd: number; measuredCells: number } }
    expect(out.cost.totalUsd).toBeCloseTo(0.101, 6)
    expect(out.cost.measuredCells).toBe(3)
  })

  test('omits the matrix on a plain run, where there is nothing to compare', async () => {
    const client = stubClient({
      getEvalRun: async () => detail({ results: [result({})] }),
    })
    const out = (await toolNamed('get_eval_run').run(client, {
      evalRunId: 'er_1',
    })) as { matrix?: unknown }
    expect(out.matrix).toBeUndefined()
  })

  // The roll-up must describe the RUN, not the filtered view — otherwise a
  // status filter would crown the best of the failures.
  test('computes the roll-up over every cell even when the list is filtered', async () => {
    const client = stubClient({
      getEvalRun: async () => detail({ results: sweep }),
    })
    const out = (await toolNamed('get_eval_run').run(client, {
      evalRunId: 'er_1',
      status: 'fail',
    })) as {
      matrix: { cells: unknown[] }
      cost: { measuredCells: number }
      results: unknown[]
    }
    expect(out.results).toHaveLength(1)
    expect(out.matrix.cells).toHaveLength(3)
    expect(out.cost.measuredCells).toBe(3)
  })
})

describe('get_eval_run — narrowing and paging', () => {
  const many = Array.from({ length: 70 }, (_, i) => { return result({
      id: `res_${i}`,
      rowId: `row_${i}`,
      status: i < 5 ? 'fail' : 'pass',
      modelId: i % 2 === 0 ? 'even' : 'odd',
    }) },
  )

  test('pages past the first window rather than dropping the tail', async () => {
    const client = stubClient({ getEvalRun: async () => detail({ results: many }) })
    const first = (await toolNamed('get_eval_run').run(client, {
      evalRunId: 'er_1',
    })) as {
      results: unknown[]
      resultsWindow: { offset: number; shown: number; matched: number }
      note: string
    }
    expect(first.results).toHaveLength(60)
    expect(first.resultsWindow).toEqual({ offset: 0, shown: 60, matched: 70 })
    expect(first.note).toContain('offset: 60')

    const second = (await toolNamed('get_eval_run').run(client, {
      evalRunId: 'er_1',
      offset: 60,
    })) as { results: unknown[]; resultsWindow: { offset: number } }
    // The ten a `note` used to swallow.
    expect(second.results).toHaveLength(10)
    expect(second.resultsWindow.offset).toBe(60)
  })

  test('filters by model id', async () => {
    const client = stubClient({ getEvalRun: async () => detail({ results: many }) })
    const out = (await toolNamed('get_eval_run').run(client, {
      evalRunId: 'er_1',
      modelId: 'odd',
    })) as { resultsWindow: { matched: number } }
    expect(out.resultsWindow.matched).toBe(35)
  })

  test('a filter that matches nothing names what was available', async () => {
    const client = stubClient({ getEvalRun: async () => detail({ results: many }) })
    const out = (await toolNamed('get_eval_run').run(client, {
      evalRunId: 'er_1',
      modelId: 'nope',
    })) as { error: string; available: { modelIds: string[] } }
    expect(out.error).toContain('match those filters')
    expect(out.available.modelIds.sort()).toEqual(['even', 'odd'])
  })
})

describe('get_eval_run — what a verdict carries', () => {
  test('keeps a decision judge’s raw probability beside its pass', async () => {
    const client = stubClient({
      getEvalRun: async () => { return detail({
          results: [
            result({
              snapshot: snapshot('Borderline', [
                { type: 'decision_judge', rubric: 'Is it grounded?', threshold: 0.5 },
              ]),
              checkResults: [
                { pass: true, probability: 0.52, reason: 'p=0.52 ≥ 0.50' },
              ],
            }),
          ],
        }) },
    })
    const out = (await toolNamed('get_eval_run').run(client, {
      evalRunId: 'er_1',
    })) as { results: { checks: { probability: number; pass: boolean }[] }[] }
    // 0.52 and 0.99 are both a pass and only one of them is worth looking at.
    // Recovering it by string-parsing `reason` is not a contract.
    expect(out.results[0]?.checks[0]?.probability).toBe(0.52)
    expect(out.results[0]?.checks[0]?.pass).toBe(true)
  })

  test('says which Goal each verdict belongs to', async () => {
    const withGoal = result({})
    withGoal.snapshot = {
      row: { name: 'Sample', description: null, input: {}, tools: {}, checks: { op: 'and', checks: [] } },
      target: { setId: 'set_7', setName: 'Refusal cases' },
    } as never
    const client = stubClient({
      getEvalRun: async () => detail({ results: [withGoal] }),
    })
    const out = (await toolNamed('get_eval_run').run(client, {
      evalRunId: 'er_1',
    })) as { results: { goalId: string; goal: string }[] }
    // `run_eval` takes setIds PLURAL — without this a multi-goal report cannot
    // say which goal regressed.
    expect(out.results[0]?.goalId).toBe('set_7')
    expect(out.results[0]?.goal).toBe('Refusal cases')
  })
})

describe('run_eval — gating the models before spending anything', () => {
  const oneSampleSet = {
    set: { id: 'set_1', name: 'Goal', targetKind: 'agent', targetId: 'ag_1' },
    rows: [{ id: 'row_0', archived: false }],
  }

  const modelCatalog = (
    models: { id: string; capabilities?: Record<string, boolean> }[],
  ): Partial<WfDataClient> => ({
    listModels: async () => { return models.map((m) => ({
        id: m.id,
        label: m.id,
        capabilities: m.capabilities ?? {
          tools: true,
          structuredOutput: true,
          reasoning: true,
        },
      })) },
  })

  test('refuses an id that is not in the catalog, and launches nothing', async () => {
    let created = false
    const client = stubClient({
      ...modelCatalog([{ id: 'venice:llama' }]),
      listAgents: async () => [] as never,
      getEvalSet: async () => oneSampleSet as never,
      createEvalRun: async () => {
        created = true
        return { evalRunId: 'er_1' }
      },
    })
    const out = (await toolNamed('run_eval').run(client, {
      setIds: ['set_1'],
      // The provider-native half of a composite id — the exact mistake
      // `list_models` exists to prevent, which used to fail at the provider
      // after the sweep had launched.
      models: ['llama'],
    })) as { error: string }
    expect(out.error).toContain('llama')
    expect(out.error).toContain('list_models')
    expect(created).toBe(false)
  })

  test('refuses a model the target agent is known to fail on', async () => {
    let created = false
    const client = stubClient({
      ...modelCatalog([
        { id: 'a:no-tools', capabilities: { tools: false, structuredOutput: true } },
      ]),
      // The agent has tools attached, so its model must be able to call them.
      listAgents: async () => { return [{ id: 'ag_1', modelRequirements: { tools: true } }] as never },
      getEvalSet: async () => oneSampleSet as never,
      createEvalRun: async () => {
        created = true
        return { evalRunId: 'er_1' }
      },
    })
    const out = (await toolNamed('run_eval').run(client, {
      setIds: ['set_1'],
      models: ['a:no-tools'],
    })) as { error: string; requirements: unknown }
    // Every cell of that column would error, three in a row latch the circuit
    // breaker, and the report reads as an outage.
    expect(out.error).toContain('no tool calling')
    expect(out.requirements).toEqual({ tools: true })
    expect(created).toBe(false)
  })

  test('does not gate a model whose capabilities are unknown', async () => {
    const client = stubClient({
      ...driveStubs(),
      // No `capabilities` at all — the pre-refresh fallback list. Unknown is not
      // the same as known-to-lack.
      listModels: async () => [{ id: 'a:mystery', label: 'Mystery' }] as never,
      listAgents: async () => { return [{ id: 'ag_1', modelRequirements: { tools: true } }] as never },
      getEvalSet: async () => oneSampleSet as never,
      startEvalRun: async () => ({ wfRunId: 'run_1' }),
      getRunStatus: async () => ({ status: 'running', error: null }) as never,
    })
    const out = (await toolNamed('run_eval').run(client, {
      setIds: ['set_1'],
      models: ['a:mystery'],
    })) as { evalRunId?: string; error?: string }
    expect(out.error).toBeUndefined()
    expect(out.evalRunId).toBe('er_1')
  })

  test('an unreadable catalog means "cannot check", not "refuse everything"', async () => {
    const client = stubClient({
      ...driveStubs(),
      listModels: async () => {
        throw new Error('catalog down')
      },
      getEvalSet: async () => oneSampleSet as never,
      startEvalRun: async () => ({ wfRunId: 'run_1' }),
      getRunStatus: async () => ({ status: 'running', error: null }) as never,
    })
    const out = (await toolNamed('run_eval').run(client, {
      setIds: ['set_1'],
      models: ['a:anything'],
    })) as { evalRunId?: string; error?: string }
    expect(out.error).toBeUndefined()
    expect(out.evalRunId).toBe('er_1')
  })
})

describe('run_eval — per-model attempts and the judge pin', () => {
  const setWithRows = (n: number) => ({
    set: { id: 'set_1', name: 'Goal', targetKind: 'agent', targetId: 'ag_1' },
    rows: Array.from({ length: n }, (_, i) => ({ id: `row_${i}`, archived: false })),
  })

  const stubs = (over: Partial<WfDataClient> = {}) => {
    let plan: { cells: unknown[]; judgeModelId?: string } | null = null
    return {
      client: stubClient({
        createEvalRun: async (input: { plan?: unknown }) => {
          plan = input.plan as typeof plan
          return { evalRunId: 'er_1' }
        },
        getEvalRunDrive: async () => null,
        listModels: async () => { return [
            { id: 'baseline', label: 'b', capabilities: {} },
            { id: 'candidate', label: 'c', capabilities: {} },
          ] as never },
        listAgents: async () => [] as never,
        getEvalSet: async () => setWithRows(2) as never,
        ...over,
      }),
      planOf: () => plan,
    }
  }

  // "Best-of-5 on the candidate, 1 on the baseline" is the natural variance
  // experiment, and uniform attempts multiply the whole matrix instead.
  test('varies attempts per model instead of across the whole sweep', async () => {
    const { client, planOf } = stubs()
    const out = (await toolNamed('run_eval').run(client, {
      setIds: ['set_1'],
      models: ['baseline', 'candidate'],
      attemptsByModel: { candidate: 5 },
    })) as {
      launched: { cellsPerSample: number; attemptsPerModel: Record<string, number> }
    }
    expect(out.launched.attemptsPerModel).toEqual({
      baseline: 1,
      candidate: 5,
    })
    // 1 baseline attempt + 5 candidate attempts, one prompt column each.
    expect(out.launched.cellsPerSample).toBe(6)
    // 2 samples × 6 = 12 cells, well under the cap a uniform 5 would have
    // pushed toward.
    expect(planOf()?.cells).toHaveLength(12)
  })

  test('ignores an override for a model that is not in the sweep', async () => {
    const { client } = stubs()
    const out = (await toolNamed('run_eval').run(client, {
      setIds: ['set_1'],
      models: ['baseline'],
      attemptsByModel: { notInTheSweep: 9 },
    })) as { launched: { attemptsPerModel: Record<string, number> } }
    expect(out.launched.attemptsPerModel).toEqual({ baseline: 1 })
  })

  // The judge is the measuring instrument: unpinned it is whatever sorts first
  // in the enabled catalog, so enabling a model silently re-grades a suite and
  // the drift report blames the agent.
  test('freezes the judge onto the plan so a resuming driver grades the same way', async () => {
    const { client, planOf } = stubs()
    const out = (await toolNamed('run_eval').run(client, {
      setIds: ['set_1'],
      judgeModelId: 'venice:judge',
    })) as { launched: { judge: string } }
    expect(planOf()?.judgeModelId).toBe('venice:judge')
    expect(out.launched.judge).toBe('venice:judge')
  })

  test('says plainly when the judge is unpinned', async () => {
    const { client } = stubs()
    const out = (await toolNamed('run_eval').run(client, {
      setIds: ['set_1'],
    })) as { launched: { judge: string } }
    expect(out.launched.judge).toContain('unpinned')
  })
})

describe('resume_eval_run', () => {
  test('ticks a stalled sweep and reports what moved', async () => {
    let ticked = 0
    let results = 1
    const client = stubClient({
      getEvalRun: async () => { return detail({
          status: 'running',
          total: 4,
          results: Array.from({ length: results }, (_, i) => { return result({ id: `res_${i}`, rowId: `row_${i}` }) },
          ),
        }) },
      getEvalRunDrive: async (evalRunId: string) => {
        ticked += 1
        results = 2
        return {
          evalRunId,
          status: 'running',
          plan: parseEvalPlan({
            version: 1,
            cells: [{ rowId: 'row_0' }, { rowId: 'row_1' }],
            concurrency: 1,
            timeoutMs: 1000,
          }),
          driveState: EMPTY_DRIVE_STATE,
          settledKeys: [],
        }
      },
      saveEvalRunDrive: async () => ({ ok: true as const }),
      startEvalRun: async () => ({ wfRunId: 'run_1' }),
      getRunStatus: async () => ({ status: 'running', error: null }) as never,
    })
    const out = (await toolNamed('resume_eval_run').run(client, {
      evalRunId: 'er_1',
    })) as { done: boolean; progressedBy: number; next: string }
    expect(ticked).toBeGreaterThan(0)
    expect(out.done).toBe(false)
    expect(out.progressedBy).toBe(1)
    expect(out.next).toContain('resume_eval_run again')
  })

  test('changes nothing on a run that already finished', async () => {
    let drove = false
    const client = stubClient({
      getEvalRun: async () => detail({ results: [], status: 'completed' }),
      getEvalRunDrive: async () => {
        drove = true
        return null
      },
    })
    const out = (await toolNamed('resume_eval_run').run(client, {
      evalRunId: 'er_1',
    })) as { done: boolean; note: string }
    expect(out.done).toBe(true)
    expect(out.note).toContain('already complete')
    expect(drove).toBe(false)
  })

  test('will not restart a cancelled sweep', async () => {
    const client = stubClient({
      getEvalRun: async () => detail({ results: [], status: 'cancelled' }),
    })
    const out = (await toolNamed('resume_eval_run').run(client, {
      evalRunId: 'er_1',
    })) as { done: boolean; note: string }
    expect(out.done).toBe(true)
    expect(out.note).toContain('cancelled')
  })

  test('explains a pre-plan run rather than surfacing a stack', async () => {
    const client = stubClient({
      getEvalRun: async () => detail({ results: [], status: 'running' }),
      getEvalRunDrive: async (evalRunId: string) => ({
        evalRunId,
        status: 'running',
        // The permanent condition: created before plans were persisted.
        plan: null,
        driveState: EMPTY_DRIVE_STATE,
        settledKeys: [],
      }),
    })
    const out = (await toolNamed('resume_eval_run').run(client, {
      evalRunId: 'er_1',
    })) as { error: string }
    expect(out.error).toContain('no plan')
  })

  test('a missing run is an answer, not a throw', async () => {
    const client = stubClient({ getEvalRun: async () => null })
    const out = (await toolNamed('resume_eval_run').run(client, {
      evalRunId: 'nope',
    })) as { error: string }
    expect(out.error).toContain('No eval run found')
  })
})

describe('cancel_eval_run', () => {
  test('stops a sweep and says what it kept', async () => {
    const client = stubClient({
      cancelEvalRun: async () => ({
        cancelled: true,
        status: 'cancelled',
        settled: 12,
        total: 100,
      }),
    })
    const out = (await toolNamed('cancel_eval_run').run(client, {
      evalRunId: 'er_1',
    })) as { cancelled: boolean; note: string }
    expect(out.cancelled).toBe(true)
    // The 88 that were never launched are the money this tool saves.
    expect(out.note).toContain('12 of 100')
  })

  test('reports a no-op rather than implying it stopped something', async () => {
    const client = stubClient({
      cancelEvalRun: async () => ({
        cancelled: false,
        status: 'completed',
        settled: 4,
        total: 4,
      }),
    })
    const out = (await toolNamed('cancel_eval_run').run(client, {
      evalRunId: 'er_1',
    })) as { cancelled: boolean; note: string }
    expect(out.cancelled).toBe(false)
    expect(out.note).toContain('already "completed"')
  })
})
