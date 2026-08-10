import { resolveGraphEngine } from '../engine/graph-engine'
import type {
  StartGraphRunInput,
  StartGraphRunResult,
} from '../engine/run-input'
import { createWfDb } from '../storage/client'
import { createRun, getVersionGraph } from '../storage/data'

import type { GraphWorkflowParams } from './graph-workflow'
import type { RunRoom } from './run-room'

// Turnkey run starter for the host worker. Mints the RunRoom address, creates
// the `wf_run` row, primes the room, and kicks off the GraphWorkflow instance —
// returning the ids a caller needs to subscribe (RunRoom) and poll (instance).

export interface GraphRunBindings {
  /** The SDK's own D1 (`wf_*` tables) — see `GraphWorkflowEnv.WF_DB`. */
  WF_DB: D1Database
  RUN_ROOM: DurableObjectNamespace<RunRoom>
  GRAPH_WORKFLOW: Workflow<GraphWorkflowParams>
}

// Declared in `../engine/run-input` (they name no Cloudflare type, so a host
// across a service boundary can import them without Workers types), re-exported
// here so this stays the one-stop import for a Worker.
export type { StartGraphRunInput, StartGraphRunResult }

// A stable 32-hex trace id (Sentry-compatible) minted per run. Kept local to
// this import-safe module (no `@sentry/cloudflare`) so `startGraphRun` stays
// loadable from any server runtime; only `crypto` is required, which both
// workerd and the host runtime provide.
function newTraceId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function startGraphRun(
  env: GraphRunBindings,
  input: StartGraphRunInput,
): Promise<StartGraphRunResult> {
  const db = createWfDb(env.WF_DB)

  // Which backend takes this run. An explicit `input.engine` wins (the A/B
  // escape hatch); otherwise it comes from the graph's trigger node. Reading the
  // graph here costs one extra D1 read on the start path — unavoidable, since
  // the choice is *which host to hand the run to* and so has to be made before
  // either host has loaded anything.
  let engine = input.engine
  if (!engine) {
    const version = await getVersionGraph(db, input.workflowVersionId)
    if (!version) {
      throw new Error(`Workflow version ${input.workflowVersionId} not found.`)
    }
    engine = resolveGraphEngine(version.graph)
  }

  const traceId = newTraceId()
  const workflowRunId = await createRun(db, {
    workflowVersionId: input.workflowVersionId,
    triggerKind: input.triggerKind,
    subjectId: input.subjectId,
    correlationId: input.correlationId,
    actorId: input.actorId,
    isEval: input.isEval,
    sentryTraceId: traceId,
  })

  const runId = crypto.randomUUID()
  const room = env.RUN_ROOM.get(env.RUN_ROOM.idFromName(runId))
  await room.init(input.label)

  const params: GraphWorkflowParams = {
    runId,
    workflowRunId,
    workflowVersionId: input.workflowVersionId,
    triggerInput: input.triggerInput,
    runContext: {
      subjectId: input.subjectId,
      correlationId: input.correlationId,
      actorId: input.actorId,
      triggerKind: input.triggerKind,
      promptVariables: input.promptVariables,
      simulate: input.simulate,
      isEval: input.isEval,
      fixtures: input.fixtures,
      freezeTools: input.freezeTools,
      agentOverride: input.agentOverride,
      executionOverride: input.executionOverride,
      traceId,
    },
    resumeFromRunId: input.resumeFromRunId,
  }

  // Both branches are fire-and-forget by design: they return once the run is
  // accepted, not once it finishes. Callers subscribe via the RunRoom (`runId`)
  // and poll `wf_run` (`workflowRunId`) exactly the same way for either engine.
  if (engine === 'inline') {
    await room.startInline(params)
    return { runId, workflowRunId, instanceId: null, engine }
  }

  const instance = await env.GRAPH_WORKFLOW.create({ params })

  return { runId, workflowRunId, instanceId: instance.id, engine }
}
