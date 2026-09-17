import { describe, expect, test } from 'bun:test'

import type { GraphWorkflowParams } from './graph-workflow'
import {
  createInflightKeeper,
  INFLIGHT_KEY,
  INLINE_INTERRUPTED_REASON,
  type InflightRun,
  type InflightStorage,
} from './inflight'

// The room's survival across its own restart. The invariant under test: a run
// that is in flight when the Durable Object dies is picked back up by the NEXT
// instance, in place, from the same record — and a run that keeps dying is
// failed rather than resumed forever. "The next instance" is modelled exactly
// as it happens in production: a second keeper built over the same storage,
// with no walk of its own.

const PARAMS: GraphWorkflowParams = {
  runId: 'room-1',
  workflowRunId: 'run-1',
  workflowVersionId: 'v-1',
  triggerInput: { n: 1 },
  runContext: { triggerKind: 'go' },
}

/** DO storage + alarm, as a Map. Survives "restarts" because the test keeps it. */
function fakeStorage() {
  const map = new Map<string, unknown>()
  let alarmAt: number | null = null
  const storage: InflightStorage = {
    get: <T>(key: string) => Promise.resolve(map.get(key) as T | undefined),
    put: <T>(key: string, value: T) => {
      map.set(key, value)
      return Promise.resolve()
    },
    delete: (key: string) => Promise.resolve(map.delete(key)),
    setAlarm: (at: number) => {
      alarmAt = at
      return Promise.resolve()
    },
    deleteAlarm: () => {
      alarmAt = null
      return Promise.resolve()
    },
  }
  return {
    storage,
    record: () => map.get(INFLIGHT_KEY) as InflightRun | undefined,
    alarmAt: () => alarmAt,
  }
}

type Launch = {
  params: GraphWorkflowParams
  resume?: { attempt: number; reason: string }
}

/** One "instance" of the room: its own launches, its own abandon log. */
function instance(
  storage: InflightStorage,
  opts: { maxResumes?: number; now?: () => number } = {},
) {
  const launches: Launch[] = []
  const abandoned: Array<{ runId: string; message: string }> = []
  const keeper = createInflightKeeper({
    storage,
    launch: (params, resume) => {
      launches.push({ params, resume })
    },
    abandon: (params, message) => {
      abandoned.push({ runId: params.workflowRunId, message })
      return Promise.resolve()
    },
    heartbeatMs: 1000,
    now: opts.now,
    maxResumes: opts.maxResumes,
  })
  return { keeper, launches, abandoned }
}

describe('a run in flight is on record', () => {
  test('start records the run and arms the heartbeat before launching', async () => {
    const s = fakeStorage()
    const room = instance(s.storage, { now: () => 5000 })
    await room.keeper.start(PARAMS)

    expect(s.record()).toEqual({ params: PARAMS, resumes: 0, startedAt: 5000 })
    expect(s.alarmAt()).toBe(6000)
    expect(room.launches).toEqual([{ params: PARAMS, resume: undefined }])
  })

  test('a finished run leaves nothing behind', async () => {
    const s = fakeStorage()
    const room = instance(s.storage)
    await room.keeper.start(PARAMS)
    await room.keeper.finished()

    expect(s.record()).toBeUndefined()
    expect(s.alarmAt()).toBeNull()
  })

  test('the heartbeat re-arms while the walk is alive and does nothing else', async () => {
    const s = fakeStorage()
    const room = instance(s.storage, { now: () => 5000 })
    await room.keeper.start(PARAMS)
    await room.keeper.alarm({ walkAlive: true })

    expect(s.alarmAt()).toBe(6000)
    expect(room.launches).toHaveLength(1)
    expect(s.record()?.resumes).toBe(0)
  })

  test('a stray alarm after cleanup is a no-op', async () => {
    const s = fakeStorage()
    const room = instance(s.storage)
    await room.keeper.alarm({ walkAlive: false })
    expect(room.launches).toHaveLength(0)
    expect(room.abandoned).toHaveLength(0)
  })
})

describe('the next instance resumes an interrupted run', () => {
  test('record + no walk → relaunch in place with resumeFromRunId = own id', async () => {
    const s = fakeStorage()
    const first = instance(s.storage)
    await first.keeper.start(PARAMS)
    // The isolate dies here. Its storage — and its alarm — survive.

    const second = instance(s.storage)
    await second.keeper.alarm({ walkAlive: false })

    expect(second.launches).toEqual([
      {
        params: { ...PARAMS, resumeFromRunId: 'run-1' },
        resume: { attempt: 1, reason: INLINE_INTERRUPTED_REASON },
      },
    ])
    // Still on record — the resumed walk can itself be interrupted.
    expect(s.record()?.resumes).toBe(1)
    expect(s.alarmAt()).not.toBeNull()
    expect(second.abandoned).toHaveLength(0)
  })

  test('gives up after the cap: fails the run, clears the record, never relaunches', async () => {
    const s = fakeStorage()
    await instance(s.storage).keeper.start(PARAMS)

    await instance(s.storage, { maxResumes: 2 }).keeper.alarm({
      walkAlive: false,
    })
    await instance(s.storage, { maxResumes: 2 }).keeper.alarm({
      walkAlive: false,
    })
    expect(s.record()?.resumes).toBe(2)

    const last = instance(s.storage, { maxResumes: 2 })
    await last.keeper.alarm({ walkAlive: false })

    expect(last.launches).toHaveLength(0)
    expect(last.abandoned).toEqual([
      {
        runId: 'run-1',
        message: `${INLINE_INTERRUPTED_REASON}; gave up after 2 resumes`,
      },
    ])
    expect(s.record()).toBeUndefined()
    expect(s.alarmAt()).toBeNull()
  })

  test('a storage that cannot be written still launches the run', async () => {
    const broken: InflightStorage = {
      get: () => Promise.resolve(undefined),
      put: () => Promise.reject(new Error('storage unavailable')),
      delete: () => Promise.resolve(false),
      setAlarm: () => Promise.resolve(),
      deleteAlarm: () => Promise.resolve(),
    }
    const room = instance(broken)
    await room.keeper.start(PARAMS)
    expect(room.launches).toHaveLength(1)
  })
})
