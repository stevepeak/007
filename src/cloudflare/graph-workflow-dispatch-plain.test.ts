import { beforeEach, describe, expect, test } from 'bun:test'
import type { WorkflowStep } from 'cloudflare:workers'
import { asc } from 'drizzle-orm'

import type { WfSdkConfig } from '../engine/config'
import type { TextNode } from '../engine/graph'
import type { ExecutableNode, Scheduler } from '../engine/scheduler'
import type { RunLogEntry } from '../engine/stream-sink'
import { createWfDb, type WfDb } from '../storage/client'
import { appendRunLog } from '../storage/data'
import { d1FromSqlite, migratedSqlite, wrapSqlite } from '../storage/db-test-helpers'
import { wfRunLog } from '../storage/schema'

import type { GraphWorkflowEnv, GraphWorkflowParams } from './graph-workflow'
import {
  describeStepTimeout,
  dispatchPlain,
} from './graph-workflow-dispatch-plain'
import type { CapturedFailure, RunCtx } from './graph-workflow-dispatch-run-ctx'
import { createRunCounters } from './step-counter'

// The ordinary node's durable dispatch — the path every kind but `iteration` and
// `workflow` takes, and which had no test at all while it lived inside
// `dispatchNode`'s 377-line body.
//
// A `text` node is the subject on purpose: it is deterministic and I/O-free, so
// what the assertions below are actually reading is the DISPATCH — the step key it
// opens, the feed it persists while the node runs, the account it leaves when the
// node throws, and what a retry does to all three.

const TEXT_NODE = {
  id: 'n1',
  kind: 'text',
  label: 'Compose the letter',
  position: { x: 0, y: 0 },
  informUser: { mode: 'off' },
  config: { body: 'Dear ${name},', inputs: { name: { kind: 'literal', value: 'Ada' } } },
} as unknown as TextNode

/**
 * A stand-in for the Workflows runtime with the one behaviour that matters here:
 * a journal. A step whose name was already settled returns its recorded value
 * WITHOUT re-running the body, which is what makes a replay look different from a
 * first pass. `attempts` records every body that actually ran.
 */
function fakeStep() {
  const journal = new Map<string, unknown>()
  const attempts: string[] = []
  const step = {
    do(name: string, ...rest: unknown[]) {
      const body = (rest.at(-1) ?? rest[0]) as () => Promise<unknown>
      if (journal.has(name)) return Promise.resolve(journal.get(name))
      attempts.push(name)
      return body().then((value) => {
        journal.set(name, value)
        return value
      })
    },
  }
  return { step: step as unknown as WorkflowStep, journal, attempts }
}

let db: WfDb
let ctx: RunCtx<unknown, GraphWorkflowEnv>
let runSink: RunLogEntry[]
let recorded: unknown[]
let stepper: ReturnType<typeof fakeStep>

beforeEach(() => {
  // ONE sqlite handle behind two faces: the D1 binding the dispatch re-wraps
  // inside its own step closures, and a `WfDb` these assertions read rows back
  // through. Anything the dispatch writes is therefore visible here.
  const sqlite = migratedSqlite()
  db = wrapSqlite(sqlite)
  runSink = []
  recorded = []
  stepper = fakeStep()
  ctx = {
    step: stepper.step,
    env: { WF_DB: d1FromSqlite(sqlite) } as unknown as GraphWorkflowEnv,
    config: {
      buildRunDeps: () => Promise.resolve({}),
      getModel: () => {
        throw new Error('a text node must not resolve a model')
      },
      toolRegistry: {},
    } as unknown as WfSdkConfig<unknown>,
    logger: { error: () => {}, warn: () => {}, info: () => {} },
    p: {
      workflowRunId: 'run-1',
      workflowVersionId: 'v-1',
      runContext: { triggerKind: 'manual', promptVariables: {} },
    } as unknown as GraphWorkflowParams,
    manifest: [],
    sink: {
      log: (e) => {
        runSink.push(e as RunLogEntry)
      },
    },
    recordOne: (args) => {
      recorded.push(args)
      return Promise.resolve()
    },
    scheduler: { getOutputs: () => new Map() } as unknown as Scheduler,
    traceId: undefined,
    instanceId: 'instance-1',
    counters: createRunCounters(),
    telemetry: { point: () => {} },
    dims: {},
    prices: new Map(),
    runStartedAtMs: null,
  } as unknown as RunCtx<unknown, GraphWorkflowEnv>
})

/**
 * Every `wf_run_log` row the dispatch persisted, as `<ordinal> <message>`.
 *
 * The ordinal has no column of its own — it is the tail of the row's
 * deterministic id (`<runId>:<nodeId>:<ordinal>`), which is what makes a replay
 * upsert onto the same slot instead of appending a duplicate. Reading it back out
 * of the id is therefore reading the thing the ordinals exist for.
 */
async function feedRows() {
  const rows = await db.select().from(wfRunLog).orderBy(asc(wfRunLog.ts), asc(wfRunLog.id))
  return rows.map((r) => `${r.id.replace('run-1:n1:', '')} ${r.message}`)
}

/** `expect.stringContaining` typed as the string it stands in for, so an array
 * of expectations still checks as `string[]`. */
function containing(text: string): string {
  return expect.stringContaining(text) as string
}

async function run(node: ExecutableNode = TEXT_NODE) {
  const bodyLogs: RunLogEntry[] = []
  let captured: CapturedFailure | null = null
  const result = await dispatchPlain(ctx, node, null, 3, bodyLogs, (c) => {
    captured = c
  })
  return { result, bodyLogs, captured: captured as CapturedFailure | null }
}

describe('dispatchPlain — the happy path', () => {
  test("opens exactly one step, keyed by the node's id", async () => {
    await run()
    expect(stepper.attempts).toEqual(['run:n1'])
  })

  test("returns the node's output for the scheduler and the recorder", async () => {
    const { result } = await run()
    expect(result.schedulerOutput).toBe('Dear Ada,')
    expect(result.recordedOutput).toBe('Dear Ada,')
  })

  test('brackets the real execution, not the dispatch envelope', async () => {
    const { result } = await run()
    expect(result.execStartedAt).toBeInstanceOf(Date)
    expect(result.execFinishedAt).toBeInstanceOf(Date)
    expect(result.execFinishedAt!.getTime()).toBeGreaterThanOrEqual(
      result.execStartedAt!.getTime(),
    )
  })

  test('returns the journalled copy of the body feed', async () => {
    // `logs` is what survives replay; `bodyLogs` is the same array.
    const { result, bodyLogs } = await run()
    expect(result.logs).toBe(bodyLogs)
  })

  test('the node is recorded as running by the ENTER step, not this one', async () => {
    // `dispatchPlain` opens `run:` only — `enterStep` and `recordTerminal` are the
    // caller's bookends, so nothing here writes a step row.
    await run()
    expect(recorded).toEqual([])
  })
})

describe('dispatchPlain — the live feed', () => {
  test('persists what the node narrates while it runs, and forwards it up', async () => {
    // A node with a progress note is the simplest emitter: `emitNodeStartProgress`
    // writes it as the first line of the body feed.
    const noted = {
      ...TEXT_NODE,
      informUser: { mode: 'static', note: 'Writing the letter' },
    } as unknown as TextNode
    const { bodyLogs } = await run(noted)
    expect(bodyLogs.map((e) => e.message)).toEqual(['Writing the letter'])
    // Persisted immediately — a consumer POLLS this table, so a node that only
    // flushed its feed at the end would be invisible for its whole duration.
    expect(await feedRows()).toEqual(['0 Writing the letter'])
    // …and mirrored to the run-level sink, which is what a live socket reads.
    expect(runSink.map((e) => e.message)).toEqual(['Writing the letter'])
  })

  test("stamps the node's own identity onto an entry that left it off", async () => {
    const noted = {
      ...TEXT_NODE,
      informUser: { mode: 'static', note: 'Writing' },
    } as unknown as TextNode
    const { bodyLogs } = await run(noted)
    expect(bodyLogs[0]).toMatchObject({
      nodeId: 'n1',
      nodeKind: 'text',
      sequence: 3,
    })
  })

  test('a node that narrates nothing leaves an empty feed', async () => {
    const { bodyLogs } = await run()
    expect(bodyLogs).toEqual([])
    expect(await feedRows()).toEqual([])
  })
})

describe('dispatchPlain — a retry', () => {
  test('announces the restart and names the step timeout as the likely cause', async () => {
    // Rows this node already appended can only be from an earlier ATTEMPT, since
    // `step.do` replays the whole closure. Seed one and dispatch again.
    await appendOne('what the abandoned attempt was doing')
    const noted = {
      ...TEXT_NODE,
      informUser: { mode: 'static', note: 'Writing the letter' },
    } as unknown as TextNode
    const { bodyLogs } = await run(noted)
    expect(bodyLogs[0].level).toBe('warn')
    expect(bodyLogs[0].message).toContain('⟲ Restarting Compose the letter')
    expect(bodyLogs[0].message).toContain(
      `step timeout: ${describeStepTimeout(TEXT_NODE as ExecutableNode)}`,
    )
    expect(bodyLogs[1].message).toBe('Writing the letter')
  })

  test("continues the ordinals so it can't overwrite the previous attempt", async () => {
    await appendOne('attempt 1 line A')
    await appendOne('attempt 1 line B', 1)
    await run()
    const rows = await feedRows()
    expect(rows.slice(0, 2)).toEqual([
      '0 attempt 1 line A',
      '1 attempt 1 line B',
    ])
    // The new attempt's own rows start where the last one stopped, so the
    // previous attempt's account of what it was doing when it died survives.
    expect(rows[2]).toStartWith('2 ⟲ Restarting')
    expect(rows).toHaveLength(3)
  })

  test('a first attempt says nothing about restarting', async () => {
    const { bodyLogs } = await run()
    expect(bodyLogs.filter((e) => e.message.includes('Restarting'))).toEqual([])
  })

  test('resets the buffer the caller hoisted, so it holds ONE attempt', async () => {
    const bodyLogs: RunLogEntry[] = [
      { level: 'info', message: 'stale line from a previous attempt' },
    ] as RunLogEntry[]
    await dispatchPlain(ctx, TEXT_NODE as ExecutableNode, null, 3, bodyLogs, () => {})
    expect(bodyLogs).toEqual([])
  })
})

describe('dispatchPlain — a failing node', () => {
  // An unbound variable is the text node's own hard failure: it throws rather
  // than let a literal `${name}` reach a human.
  const BROKEN = {
    ...TEXT_NODE,
    config: { body: 'Dear ${name},', inputs: {} },
  }

  test('captures the error detail before it crosses the step boundary', async () => {
    // This is the whole reason the capture is a callback into a hoisted local:
    // Cloudflare REBUILDS an error thrown out of `step.do`, so the outer catch
    // sees a bare stack. Inside, the real error is still in hand.
    const bodyLogs: RunLogEntry[] = []
    let captured: CapturedFailure | null = null
    await expect(
      dispatchPlain(ctx, BROKEN as ExecutableNode, null, 3, bodyLogs, (c) => {
        captured = c
      }),
    ).rejects.toThrow(/unbound variable/)
    const failure = captured as CapturedFailure | null
    expect(failure?.feed).toContain('${name}')
    expect(failure?.stored).toContain('${name}')
  })

  test('leaves the attempt\'s feed behind rather than discarding it', async () => {
    const noted = {
      ...BROKEN,
      informUser: { mode: 'static', note: 'Writing the letter' },
    } as unknown as TextNode
    const bodyLogs: RunLogEntry[] = []
    await expect(
      dispatchPlain(ctx, noted as ExecutableNode, null, 3, bodyLogs, () => {}),
    ).rejects.toThrow()
    // Without the hoist, a failed node's whole trace died with the closure and
    // the feed collapsed to "▶ node" … "✕ node failed" — no sign of what the node
    // got through, and no sign that another attempt was on its way.
    expect(bodyLogs.map((e) => e.message)).toEqual([
      'Writing the letter',
      containing('— retrying'),
    ])
    expect(await feedRows()).toEqual([
      '0 Writing the letter',
      containing('1 Compose the letter has an unbound variable'),
    ])
  })

  test('an unbound variable is left RETRYABLE, so the retry line is emitted', async () => {
    // The `— retrying` line above is the only trace an abandoned attempt leaves:
    // the capture is overwritten by the next attempt, and a step timeout kills the
    // closure from outside so no error line is ever written for it. A fault the
    // engine knows is fatal (a burned budget, an agent with no answer) skips it.
    const bodyLogs: RunLogEntry[] = []
    await expect(
      dispatchPlain(ctx, BROKEN as ExecutableNode, null, 3, bodyLogs, () => {}),
    ).rejects.toThrow()
    expect(bodyLogs.map((e) => e.level)).toEqual(['warn'])
  })
})

describe('describeStepTimeout', () => {
  test('reads minutes above a minute and seconds below it', () => {
    const at = (timeoutMs: number) => { return describeStepTimeout({
        kind: 'text',
        execution: { timeoutMs },
      } as unknown as ExecutableNode) }
    expect(at(90_000)).toBe('1.5 min')
    expect(at(60_000)).toBe('1 min')
    expect(at(45_000)).toBe('45s')
    expect(at(1_500)).toBe('2s')
  })
})

/** Append one body row for `n1`, exactly as an earlier attempt would have. */
async function appendOne(message: string, ordinal = 0) {
  await appendRunLog(createWfDb(ctx.env.WF_DB), {
    runId: 'run-1',
    nodeId: 'n1',
    ordinal,
    entry: {
      nodeId: 'n1',
      nodeKind: 'text',
      sequence: 3,
      level: 'info',
      message,
      meta: null,
      ts: Date.now() - 1000,
    },
  })
}
