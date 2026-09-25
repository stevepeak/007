import { consoleWfLogger, type WfLogger } from '../engine/logger'

import type { GraphWorkflowParams } from './graph-workflow'

// The part of a RunRoom that survives the RunRoom: a record of the run it is
// executing, kept in the Durable Object's storage for exactly as long as the
// walk is in flight, and a heartbeat alarm that outlives the isolate.
//
// Why this exists: a deploy restarts every Durable Object. The walk was an
// in-memory promise, so before this it simply stopped — `wf_run` said `running`
// forever and nothing ever came back to say otherwise. Alarms are persisted with
// the object, so the next heartbeat fires into a FRESH instance; that instance
// finds the record but no walk, which is the whole eviction detector, and
// resumes the run in place from its completed `wf_run_step` rows.
//
// Kept free of `cloudflare:workers` so it can be exercised in a plain test with
// a Map for storage; `RunRoom` is the thin adapter that binds it to the real
// `DurableObjectState`.

/** What the room remembers about a run in flight, for as long as it is. */
export type InflightRun = {
  params: GraphWorkflowParams
  /** How many times the room has already picked this run back up. */
  resumes: number
  startedAt: number
}

/** The slice of `DurableObjectStorage` the keeper uses. */
export type InflightStorage = {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
  setAlarm(scheduledTime: number): Promise<void>
  deleteAlarm(): Promise<void>
}

export const INFLIGHT_KEY = 'inflight'

/**
 * How often the room checks that its walk is still alive. Also the worst-case
 * delay between a restart and the resume — 30s is invisible next to the model
 * calls it is protecting, and far cheaper than a tighter loop on every live run.
 */
export const INLINE_HEARTBEAT_MS = 30_000

/**
 * How many restarts one run may survive before the room gives up and fails it.
 * A run that keeps dying is being killed by something a resume cannot fix (the
 * node itself takes the isolate down, say), and re-running its interrupted
 * node forever would just re-run that.
 */
export const INLINE_MAX_RESUMES = 2

export const INLINE_INTERRUPTED_REASON = 'interrupted by a worker restart'

export type InflightKeeperDeps = {
  storage: InflightStorage
  /** Start (or restart) the walk. `resume` is set on a pick-up, never a first start. */
  launch: (
    params: GraphWorkflowParams,
    resume?: { attempt: number; reason: string },
  ) => void
  /** Fail the run for good — it was interrupted more times than allowed. */
  abandon: (params: GraphWorkflowParams, message: string) => Promise<void>
  now?: () => number
  heartbeatMs?: number
  maxResumes?: number
  /**
   * Where the keeper reports the faults it swallows. Every one of them is a
   * lost safety net — a run that will not survive a restart, or one abandoned
   * outright — so they are exactly the lines that must reach the host's error
   * tracker rather than a console the deployment never reads.
   */
  logger?: WfLogger
}

export type InflightKeeper = {
  /** Record the run and arm the heartbeat, then launch. Best-effort: a room that
   *  cannot write its storage still runs the workflow, just without a net. */
  start(params: GraphWorkflowParams): Promise<void>
  /**
   * The heartbeat. Three cases, and only the last one does anything:
   *   • no record → the run finished and cleaned up; a stray alarm.
   *   • record + a live walk → re-arm and go back to sleep.
   *   • record, NO walk → this instance was created over storage a previous
   *     instance left behind: the run was interrupted. Resume it in place, or
   *     abandon it once it has been interrupted too many times.
   */
  alarm(args: { walkAlive: boolean }): Promise<void>
  /** The walk ended, however it ended: drop the record and the alarm. */
  finished(): Promise<void>
}

export function createInflightKeeper(deps: InflightKeeperDeps): InflightKeeper {
  const { storage, launch, abandon } = deps
  const logger = deps.logger ?? consoleWfLogger
  const now = deps.now ?? (() => Date.now())
  const heartbeatMs = deps.heartbeatMs ?? INLINE_HEARTBEAT_MS
  const maxResumes = deps.maxResumes ?? INLINE_MAX_RESUMES

  const remember = async (inflight: InflightRun): Promise<void> => {
    try {
      await storage.put(INFLIGHT_KEY, inflight)
      await storage.setAlarm(now() + heartbeatMs)
    } catch (err) {
      logger.error(
        `[wf] inline run ${inflight.params.workflowRunId} could not be recorded as in flight — it will not survive a restart`,
        err,
      )
    }
  }

  return {
    async start(params) {
      await remember({ params, resumes: 0, startedAt: now() })
      launch(params)
    },

    async alarm({ walkAlive }) {
      const inflight = await storage.get<InflightRun>(INFLIGHT_KEY)
      if (!inflight) return
      if (walkAlive) {
        await storage.setAlarm(now() + heartbeatMs)
        return
      }
      const runId = inflight.params.workflowRunId
      if (inflight.resumes >= maxResumes) {
        const message = `${INLINE_INTERRUPTED_REASON}; gave up after ${inflight.resumes} resumes`
        logger.error(`[wf] inline run ${runId} abandoned: ${message}`)
        await this.finished()
        await abandon(inflight.params, message)
        return
      }
      const resumes = inflight.resumes + 1
      logger.warn(
        `[wf] inline run ${runId} ${INLINE_INTERRUPTED_REASON}; resuming (attempt ${resumes})`,
      )
      await remember({ ...inflight, resumes })
      launch(
        { ...inflight.params, resumeFromRunId: runId },
        { attempt: resumes, reason: INLINE_INTERRUPTED_REASON },
      )
    },

    async finished() {
      try {
        await storage.delete(INFLIGHT_KEY)
        await storage.deleteAlarm()
      } catch (err) {
        logger.error('[wf] inline run record not cleared', err)
      }
    },
  }
}
