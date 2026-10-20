import type {
  WorkflowStep,
  WorkflowStepConfig,
} from 'cloudflare:workers'

import {
  consoleWfLogger,
  notifyHostSafely,
  type WfLogger,
} from '../engine/logger'

// Best-effort host lifecycle notification, in its own durable step (so it
// retries); see `notifyHostSafely` for why a throwing callback is swallowed.
export async function notifyHost(
  step: WorkflowStep,
  name: string,
  fn: () => void | Promise<void>,
  logger: WfLogger = consoleWfLogger,
): Promise<void> {
  await notifyHostSafely({
    name,
    logger,
    fn: async () => {
      await stepDo(step, name, async () => {
        await fn()
        return null
      })
    },
  })
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
