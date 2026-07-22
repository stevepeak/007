import type {
  WorkflowStep,
  WorkflowStepConfig,
} from 'cloudflare:workers'

import { errorMessage } from '../engine/run-node'

// Best-effort host lifecycle notification. Runs in its own durable step (so it
// retries), but a callback that ultimately throws is swallowed (logged) rather
// than changing the run outcome — the run's success/failure is already settled
// by the time we notify. Keeps a broken host callback from turning a completed
// run into a failed one, or masking the real error on the failure path.
export async function notifyHost(
  step: WorkflowStep,
  name: string,
  fn: () => void | Promise<void>,
): Promise<void> {
  try {
    await stepDo(step, name, async () => {
      await fn()
      return null
    })
  } catch (err) {
    console.error(`[wf] lifecycle callback '${name}' failed:`, errorMessage(err))
  }
}

// Cloudflare's `step.do` constrains return values to `Serializable<T>`, which
// rejects the `unknown`-typed JSON our engine produces (the values are JSON;
// the *type* is just wider than Serializable allows). This wrapper localizes
// the single cast at that boundary so call sites and the engine stay clean.
type StepBody<T> = () => Promise<T>
export function stepDo<T>(
  step: WorkflowStep,
  name: string,
  optsOrBody: WorkflowStepConfig | StepBody<T>,
  maybeBody?: StepBody<T>,
): Promise<T> {
  if (typeof optsOrBody === 'function') {
    return step.do(name, optsOrBody as never) as Promise<T>
  }
  return step.do(name, optsOrBody, maybeBody as never) as Promise<T>
}
