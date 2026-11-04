import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers'

import { runEvalSweep } from '../eval/sweep'
import type { WfDataClient } from '../server/protocol'

import type { EvalSweepParams } from './eval-sweep-start'

// Past the longest thing a step does: a judge call, on its 120-second budget.
const SWEEP_STEP_OPTS = {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
} as const

/**
 * The Workflow class that runs one eval sweep. `createClient` is how the host
 * supplies a data client for this Worker's own process, with no user on it.
 */
export function makeEvalSweepWorkflow<E>(args: {
  createClient: (env: E) => WfDataClient
}): new (
  ctx: ExecutionContext,
  env: E,
) => WorkflowEntrypoint<E, EvalSweepParams> {
  return class EvalSweepWorkflow extends WorkflowEntrypoint<
    E,
    EvalSweepParams
  > {
    override async run(
      event: WorkflowEvent<EvalSweepParams>,
      step: WorkflowStep,
    ): Promise<void> {
      await runEvalSweep(
        args.createClient(this.env),
        {
          // Everything a sweep's steps return is plain JSON. Workflows' own
          // constraint can't see that through the generic.
          do: (name, fn) => step.do(name, SWEEP_STEP_OPTS, fn as never) as never,
          waitForEvent: (name, opts) => step.waitForEvent(name, opts),
        },
        { evalRunId: event.payload.evalRunId },
      )
    }
  }
}
