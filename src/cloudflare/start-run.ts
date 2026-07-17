import { createWfDb } from '../storage/client'
import { createRun } from '../storage/data'

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
  /** Marks the produced `wf_run` as eval-owned (hidden from the Runs explorer). */
  isEval?: boolean
  /** Optional human label for the RunRoom snapshot. */
  label?: string
  /** Resume mode: replay a prior failed run's completed steps into this run and
   * pick up at the failed node. The prior run must use the same version. */
  resumeFromRunId?: string
}

export type StartGraphRunResult = {
  runId: string
  workflowRunId: string
  instanceId: string
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

  const instance = await env.GRAPH_WORKFLOW.create({
    params: {
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
        traceId,
      },
      resumeFromRunId: input.resumeFromRunId,
    },
  })

  return { runId, workflowRunId, instanceId: instance.id }
}
