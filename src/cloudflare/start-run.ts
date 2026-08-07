import { resolveGraphEngine } from '../engine/graph-engine'
import type { NodeExecution, WfEngine } from '../engine/graph-schema'
import { createWfDb } from '../storage/client'
import { createRun, getVersionGraph } from '../storage/data'

import type { GraphWorkflowParams } from './graph-workflow'
import type { RunRoom } from './run-room'

// Turnkey run starter for the host worker. Mints the RunRoom address, creates
// the `wf_run` row, primes the room, and kicks off the GraphWorkflow instance —
// returning the ids a caller needs to subscribe (RunRoom) and poll (instance).

export interface GraphRunBindings {
  DB: D1Database
  RUN_ROOM: DurableObjectNamespace<RunRoom>
  GRAPH_WORKFLOW: Workflow<GraphWorkflowParams>
}

export type StartGraphRunInput = {
  workflowVersionId: string
  triggerKind: string
  triggerInput: unknown
  subjectId?: string
  correlationId?: string
  promptVariables?: Record<string, string | undefined>
  /**
   * Eval signal — execute the real graph and write a real trace, but neutralize
   * side-effecting tools (write tools no-op, read tools return their `fixtures`
   * entry). Off for normal runs.
   */
  simulate?: boolean
  /** Canned tool outputs consumed under `simulate`, keyed by tool id. */
  fixtures?: Record<string, unknown>
  /**
   * Eval synthesis signal — run every agent node with an empty tool set so the
   * model answers from its seeded message history alone. See RunContext.
   */
  freezeTools?: boolean
  /** Marks the produced `wf_run` as eval-owned (hidden from the Runs explorer). */
  isEval?: boolean
  /**
   * Eval matrix override — swaps the modelId and/or system prompt on every agent
   * node for this run (the eval wrapper's single agent). See RunContext.
   */
  agentOverride?: { modelId?: string; prompt?: string }
  /**
   * Run-scoped step policy layered onto every node's own, TIGHTENING only.
   * Bounds what this one run may spend without touching the published graph —
   * eval runs pass `EVAL_NODE_EXECUTION` so a failing node reports in minutes
   * instead of exhausting the 20-minute AI default four times over.
   */
  executionOverride?: NodeExecution
  /** Optional human label for the RunRoom snapshot. */
  label?: string
  /** Resume mode: replay a prior failed run's completed steps into this run and
   * pick up at the failed node. The prior run must use the same version. */
  resumeFromRunId?: string
  /**
   * Force an execution backend for THIS run, ignoring the graph's own
   * `trigger.config.engine`. A per-run escape hatch for A/B-ing the two
   * backends against the same published version without republishing it —
   * leave it unset for normal runs.
   */
  engine?: WfEngine
}

export type StartGraphRunResult = {
  runId: string
  workflowRunId: string
  /**
   * The Cloudflare Workflows instance id, or `null` on the inline engine (no
   * instance exists — the run lives in its RunRoom). Callers poll `wf_run` by
   * `workflowRunId` either way; this is for instance-level introspection only.
   */
  instanceId: string | null
  /** Which backend actually took the run. */
  engine: WfEngine
}

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
  const db = createWfDb(env.DB)

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
      triggerKind: input.triggerKind,
      promptVariables: input.promptVariables,
      simulate: input.simulate,
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
