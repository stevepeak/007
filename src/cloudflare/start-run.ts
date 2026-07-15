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

export async function startGraphRun(
  env: GraphRunBindings,
  input: StartGraphRunInput,
): Promise<StartGraphRunResult> {
  const db = createWfDb(env.DB)
  const workflowRunId = await createRun(db, {
    workflowVersionId: input.workflowVersionId,
    triggerKind: input.triggerKind,
    subjectId: input.subjectId,
    correlationId: input.correlationId,
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
      },
      resumeFromRunId: input.resumeFromRunId,
    },
  })

  return { runId, workflowRunId, instanceId: instance.id }
}
