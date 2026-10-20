import type { RunContext, WfSdkConfig } from '../engine/config'
import { errorFeedLine } from '../engine/error-detail'
import { executeWorkflow } from '../engine/executor'
import { modelBudgetFor } from '../engine/model-budget'
import { resolveNodeTimeoutMs } from '../engine/node-timeout'
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

export type RunAgentResult = {
  /** The agent's output — for an `object` agent, the validated object. */
  output: unknown
  /** The recorded run, for linking a caller's own record to it. */
  workflowRunId: string
  durationMs: number
}

// Per-isolate: an agent's wrapper version is stable once created (it only
// changes when the wrapper BUILDER changes, i.e. on a deploy), so resolving it
// once saves three D1 reads on every later call. Keyed by database so two
// databases in one process (tests) can't hand each other a version id.
const wrapperVersions = new WeakMap<WfDb, Map<string, string>>()

async function wrapperVersionFor(db: WfDb, agentId: string): Promise<string> {
  let byAgent = wrapperVersions.get(db)
  if (!byAgent) {
    byAgent = new Map()
    wrapperVersions.set(db, byAgent)
  }
  const cached = byAgent.get(agentId)
  if (cached) return cached
  const { workflowVersionId } = await ensureAgentEvalWrapper(db, { agentId })
  byAgent.set(agentId, workflowVersionId)
  return workflowVersionId
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
  const { db } = opts
  const startedAt = Date.now()
  const timeoutMs = opts.timeoutMs ?? RUN_AGENT_TIMEOUT_MS

  const agentId = await agentIdBySlug(db, opts.slug)
  if (!agentId) throw new Error(`runAgent: no agent with slug "${opts.slug}"`)
  const workflowVersionId = await wrapperVersionFor(db, agentId)
  const version = await getVersionGraph(db, workflowVersionId)
  if (!version) {
    throw new Error(`runAgent: wrapper version ${workflowVersionId} is gone`)
  }

  const workflowRunId = await createRun(db, {
    workflowVersionId,
    triggerKind: MANUAL_TRIGGER_KIND,
    subjectId: opts.subjectId,
    correlationId: opts.correlationId,
    actorId: opts.actorId,
    hostContext: opts.hostContext,
  })

  // Settled by whichever finishes first — the walk or the timer — so a run the
  // timer already failed is never then marked done by a late answer.
  let settled = false
  const execute = async (): Promise<unknown> => {
    // Throws "not in the run manifest" for an agent with no published
    // version, which is the honest answer for one.
    const manifest = await resolveRunManifest(db, version.graph)
    await setRunManifest(db, { runId: workflowRunId, manifest })
    await markRunRunning(db, { runId: workflowRunId })

    const runContext: RunContext = {
      triggerKind: MANUAL_TRIGGER_KIND,
      runId: workflowRunId,
      subjectId: opts.subjectId,
      correlationId: opts.correlationId,
      actorId: opts.actorId,
      hostContext: opts.hostContext,
      promptVariables: opts.promptVariables,
      manifest,
      env: opts.env,
    }
    const result = await executeWorkflow({
      graph: version.graph,
      triggerInput: {},
      config: opts.wfConfig,
      runContext,
      recorder: createDurableRunRecorder({ db, runId: workflowRunId }),
      // The same per-node bound the inline engine applies. It has a floor
      // (`MIN_TOTAL_MS`) well above a request's patience, so the timer below
      // is what actually holds `timeoutMs`; this is what stops the provider
      // call itself rather than just abandoning it.
      resolveModelBudget: (node) => {
        return modelBudgetFor(resolveNodeTimeoutMs(node, { timeoutMs }))
      },
    })
    if (!settled) {
      settled = true
      await markRunDone(db, {
        runId: workflowRunId,
        output: result.output,
        settled: true,
      })
    }
    return result.output
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`runAgent: "${opts.slug}" timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  try {
    const output = await Promise.race([execute(), timeout])
    return { output, workflowRunId, durationMs: Date.now() - startedAt }
  } catch (err) {
    if (!settled) {
      settled = true
      await failRun(db, { runId: workflowRunId, error: errorFeedLine(err) })
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}
