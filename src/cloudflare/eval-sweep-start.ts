import type { WfLogger } from '../engine/logger'
import type { EvalSweepNotice } from '../engine/run-input'

// The host-facing half of the eval sweep workflow: starting one, and telling one
// that a cell's run settled. Import-safe, unlike the class in
// `eval-sweep-workflow.ts`, so `RunRoom`'s run path and a host's RPC can reach it.

export type EvalSweepParams = { evalRunId: string }

export type EvalSweepBindings = {
  EVAL_SWEEP_WORKFLOW: Workflow<EvalSweepParams>
}

/**
 * Start the sweep's workflow, or restart one that died. The instance id is the
 * eval run id, so a second call can never run the same sweep twice. Answers
 * `started: false` when it is already going or already finished.
 */
export async function startEvalSweepWorkflow(
  env: EvalSweepBindings,
  input: { evalRunId: string },
): Promise<{ started: boolean }> {
  const { evalRunId } = input
  let instance: WorkflowInstance
  try {
    instance = await env.EVAL_SWEEP_WORKFLOW.get(evalRunId)
  } catch {
    // Not found. Anything else fails again on the create, and surfaces there.
    await env.EVAL_SWEEP_WORKFLOW.create({
      id: evalRunId,
      params: { evalRunId },
    })
    return { started: true }
  }
  const { status } = await instance.status()
  if (status === 'errored' || status === 'terminated') {
    await instance.restart()
    return { started: true }
  }
  return { started: false }
}

/**
 * Wake the sweep waiting on this run. Best-effort: a failed notice is logged, and
 * the sweep's own wait times out and reads the run's status instead.
 */
export async function notifyEvalSweep(args: {
  env: Partial<EvalSweepBindings>
  notice: EvalSweepNotice | undefined
  runId: string
  logger: WfLogger
}): Promise<void> {
  const { env, notice, runId, logger } = args
  if (!notice) return
  try {
    if (!env.EVAL_SWEEP_WORKFLOW) {
      throw new Error('EVAL_SWEEP_WORKFLOW is not bound on this Worker.')
    }
    const sweep = await env.EVAL_SWEEP_WORKFLOW.get(notice.instanceId)
    await sweep.sendEvent({ type: notice.eventType, payload: null })
  } catch (err) {
    logger.error(`[wf] run ${runId} could not notify its eval sweep`, err)
  }
}
