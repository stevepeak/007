import type { RunContext, WfSdkConfig } from '../engine/config'
import { errorFeedLine } from '../engine/error-detail'
import { executeWorkflow } from '../engine/executor'
import { resolveWfLogger } from '../engine/logger'
import {
  MAX_ROUND_TRIP_MS,
  MAX_TOOL_MS,
  remainingBudget,
} from '../engine/model-budget'
import { MANUAL_TRIGGER_KIND } from '../engine/trigger-registry'
import { ensureAgentEvalWrapper } from '../eval/wrapper'
import type { WfDb } from '../storage/client'
import {
  agentIdBySlug,
  createRun,
  failRun,
  getVersionGraph,
  markRunDone,
  markRunRunning,
  resolveRunManifest,
  setRunManifest,
} from '../storage/data'
import { createDurableRunRecorder } from '../storage/run-recorder'

// Host seam — call ONE published agent from app code and await its answer.
//
// The playground (`executeAgentPreview`) runs an agent with no record at all,
// which is right for scratch input and wrong for production: a call nobody can
// see is a call nobody can debug, grade, or turn into an eval sample. This runs
// the agent as a real, recorded run — a `wf_run` with its trigger, agent and
// output steps, the agent step stamped with `meta.agentId` — so it shows up in
// the agent's Recent calls, the run viewer and `draft_sample_from_run` exactly
// like a call made from inside a workflow.
//
// The graph it runs is the agent's hidden eval wrapper (trigger → agent →
// output, see `eval/wrapper.ts`), because `wf_run` must name a workflow
// version and that graph is already the one-agent shape every run reader
// understands. Unpinned, it floats to the agent's latest published version,
// frozen onto the run by `resolveRunManifest` like any other run.
//
// It executes IN-PROCESS on whichever Worker calls it: it needs the SDK's D1
// and the host config, nothing else — no Durable Object, no Workflows
// instance, no service hop. A caller waiting on an answer inside a request is
// the whole point.

/** Default ceiling on the whole call, model included. */
export const RUN_AGENT_TIMEOUT_MS = 10_000

/**
 * How far past the deadline the agent's own model budget runs. The deadline
 * timer must win so the caller always gets the timeout error; the budget then
 * aborts the provider call right behind it.
 */
const ABORT_GRACE_MS = 1_000

export type RunAgentResult = {
  /** The agent's output — for an `object` agent, the validated object. */
  output: unknown
  /** The recorded run, for linking a caller's own record to it. */
  workflowRunId: string
  durationMs: number
}

// Per-isolate: an agent's wrapper version is stable once created (it only
// changes when the wrapper BUILDER changes, i.e. on a deploy), so resolving it
// once saves three D1 reads on every later call. Keyed by the underlying driver
// (`$client` — the D1 binding in a Worker), not the drizzle wrapper: callers
// mint a fresh `createWfDb` per request, so keying on that would never hit,
// while two databases in one process still can't hand each other a version id.
// Same rule as the price-map memo in `storage/data/runs-cost.ts`.
const wrapperVersions = new WeakMap<object, Map<string, string>>()

function wrapperCacheFor(db: WfDb): Map<string, string> | null {
  const client = (db as unknown as { $client?: unknown }).$client
  if (typeof client !== 'object' || client === null) return null
  let byAgent = wrapperVersions.get(client)
  if (!byAgent) {
    byAgent = new Map()
    wrapperVersions.set(client, byAgent)
  }
  return byAgent
}

/** The wrapper version's graph, re-resolving once when a cached id has gone
 *  (the wrapper was deleted or its runs purged since this isolate cached it). */
async function wrapperGraphFor(db: WfDb, agentId: string) {
  const cache = wrapperCacheFor(db)
  const cached = cache?.get(agentId)
  if (cached) {
    const version = await getVersionGraph(db, cached)
    if (version) return { workflowVersionId: cached, graph: version.graph }
    cache?.delete(agentId)
  }
  const { workflowVersionId } = await ensureAgentEvalWrapper(db, { agentId })
  const version = await getVersionGraph(db, workflowVersionId)
  if (!version) {
    throw new Error(`runAgent: wrapper version ${workflowVersionId} is gone`)
  }
  cache?.set(agentId, workflowVersionId)
  return { workflowVersionId, graph: version.graph }
}

export async function runAgent<TDeps>(opts: {
  /** The SDK's own D1 (`wf_*` tables). */
  db: WfDb
  /** The host's full SDK config — model provider, tools, deps builder. */
  wfConfig: WfSdkConfig<TDeps>
  /** Live bindings, handed to `buildRunDeps` like any run's `env`. */
  env: unknown
  /** The agent's slug — its cross-environment identity. */
  slug: string
  /** Values for the agent's `${…}` prompt variables. */
  promptVariables: Record<string, string>
  /** Opaque host scope, recorded on the run exactly as a workflow run's. */
  subjectId?: string
  correlationId?: string
  actorId?: string
  /**
   * Opaque attribution, recorded on the run — name the caller here
   * (`{ caller: 'recipes.upsert' }`); it is what tells two direct callers of
   * one agent apart in the run list.
   */
  hostContext?: Record<string, string>
  /** Ceiling on the whole call. Defaults to {@link RUN_AGENT_TIMEOUT_MS}. */
  timeoutMs?: number
}): Promise<RunAgentResult> {
  const { db, wfConfig } = opts
  const logger = resolveWfLogger(wfConfig.logger)
  const startedAt = Date.now()
  const timeoutMs = opts.timeoutMs ?? RUN_AGENT_TIMEOUT_MS

  const agentId = await agentIdBySlug(db, opts.slug)
  if (!agentId) throw new Error(`runAgent: no agent with slug "${opts.slug}"`)
  const { workflowVersionId, graph } = await wrapperGraphFor(db, agentId)

  const workflowRunId = await createRun(db, {
    workflowVersionId,
    triggerKind: MANUAL_TRIGGER_KIND,
    subjectId: opts.subjectId,
    correlationId: opts.correlationId,
    actorId: opts.actorId,
    hostContext: opts.hostContext,
  })

  let runContext: RunContext = {
    triggerKind: MANUAL_TRIGGER_KIND,
    runId: workflowRunId,
    subjectId: opts.subjectId,
    correlationId: opts.correlationId,
    actorId: opts.actorId,
    hostContext: opts.hostContext,
    promptVariables: opts.promptVariables,
    env: opts.env,
  }

  // The host's lifecycle hooks fire from HERE, after the run row says how the
  // run ended — left to the executor they would run while `wf_run` still said
  // `running`. Best-effort, as on both engines: a throwing hook is logged and
  // never changes an outcome that is already recorded.
  const execConfig: WfSdkConfig<TDeps> = {
    ...wfConfig,
    onRunComplete: undefined,
    onRunFailed: undefined,
  }
  const notifyHost = async (
    name: string,
    fn: () => void | Promise<void>,
  ): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      logger.error(`[wf] lifecycle callback '${name}' failed`, err)
    }
  }

  // The whole call's budget, spent down from `startedAt`. Handed to the agent
  // node as its model budget, so the provider call (and the tools it drives) is
  // ABORTED just past the deadline rather than abandoned behind it — without
  // this the node's own budget floors at `MIN_TOTAL_MS` and keeps spending well
  // after the caller has been told it timed out.
  const budgetMs = timeoutMs + ABORT_GRACE_MS
  const callBudget = {
    totalMs: budgetMs,
    stepMs: Math.min(budgetMs, MAX_ROUND_TRIP_MS),
    toolMs: Math.min(budgetMs, MAX_TOOL_MS),
  }

  // The walk and the timer race to CLAIM the outcome. A walk that answers
  // first records `done`, and the timer then stands down, so an answer still
  // being written is never reported as a timeout; a timer that fires first
  // fails the run, and the late answer is dropped. Anything that leaves the run
  // without a recorded `done` — timeout, a failed node, a failed write — fails
  // it.
  let claimed = false
  const claim = (): boolean => {
    if (claimed) return false
    claimed = true
    return true
  }
  let doneRecorded = false

  const execute = async (): Promise<unknown> => {
    // Throws "not in the run manifest" for an agent with no published
    // version, which is the honest answer for one.
    const manifest = await resolveRunManifest(db, graph)
    await setRunManifest(db, { runId: workflowRunId, manifest })
    await markRunRunning(db, { runId: workflowRunId })
    runContext = { ...runContext, manifest }

    const result = await executeWorkflow({
      graph,
      triggerInput: {},
      config: execConfig,
      runContext,
      recorder: createDurableRunRecorder({ db, runId: workflowRunId }),
      resolveModelBudget: () => {
        return remainingBudget(callBudget, Date.now() - startedAt)
      },
    })
    if (claim()) {
      await markRunDone(db, {
        runId: workflowRunId,
        output: result.output,
        settled: true,
      })
      doneRecorded = true
      if (wfConfig.onRunComplete) {
        await notifyHost('on-complete', () => {
          return wfConfig.onRunComplete!(runContext, {
            output: result.output,
            outputNodeId: result.outputNodeId,
          })
        })
      }
    }
    return result.output
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  // Anchored at `startedAt`, like the budget, so the two can't drift apart by
  // however long the setup reads took.
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (!claim()) return
      reject(new Error(`runAgent: "${opts.slug}" timed out after ${timeoutMs}ms`))
    }, Math.max(0, startedAt + timeoutMs - Date.now()))
  })

  try {
    const output = await Promise.race([execute(), timeout])
    return { output, workflowRunId, durationMs: Date.now() - startedAt }
  } catch (err) {
    if (!doneRecorded) {
      const error = errorFeedLine(err)
      // The caller is owed the error that ended the call, not a D1 hiccup
      // recording it.
      try {
        await failRun(db, { runId: workflowRunId, error })
      } catch (recordErr) {
        logger.error('[wf] runAgent could not record its failure', recordErr)
      }
      if (wfConfig.onRunFailed) {
        await notifyHost('on-failed', () => {
          return wfConfig.onRunFailed!(runContext, { error, workflowRunId })
        })
      }
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}
