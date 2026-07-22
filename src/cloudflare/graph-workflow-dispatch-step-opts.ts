import type { WorkflowStepConfig } from 'cloudflare:workers'

import type { NodeExecution } from '../engine/graph'

// Per-kind step.do retry/timeout policy defaults. LLM nodes get longer, retried
// steps. A node's optional `execution` policy overrides these field-by-field.
export const AI_STEP_OPTS = {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
  timeout: '3 minutes',
} as const
export const DEFAULT_STEP_OPTS = {
  retries: { limit: 2, delay: '3 seconds', backoff: 'exponential' },
  timeout: '1 minute',
} as const

// Return type is intentionally inferred (not widened to `WorkflowStepConfig`)
// so the const defaults keep their guaranteed `retries`, which `stepOptsFor`
// reads when layering a partial override.
function kindDefaultOpts(kind: string) {
  // The deterministic `branch` needs no retries/long timeout and falls through
  // to the default policy. A `workflow` node runs a whole callee subgraph
  // inline (often several LLM nodes) in one step, so it gets the longer,
  // retried AI policy — authors can raise the timeout further per-node via
  // `execution` for long callees.
  return kind === 'agent' || kind === 'workflow'
    ? AI_STEP_OPTS
    : DEFAULT_STEP_OPTS
}

// Map a node's provider-agnostic `execution` policy onto Cloudflare's
// `WorkflowStepConfig`, layered over the per-kind default so an author can
// override just a timeout or just the retry limit and inherit the rest. The
// engine schema speaks milliseconds; `step.do` accepts a number-of-ms for both
// `timeout` and retry `delay`, so we pass them straight through.
export function stepOptsFor(node: {
  kind: string
  execution?: NodeExecution
}): WorkflowStepConfig {
  const base = kindDefaultOpts(node.kind)
  const ex = node.execution
  if (!ex || (ex.timeoutMs == null && ex.retries == null)) {
    return base
  }
  return {
    timeout: ex.timeoutMs ?? base.timeout,
    retries: ex.retries
      ? {
          limit: ex.retries.limit,
          delay: ex.retries.delayMs ?? base.retries.delay,
          backoff: ex.retries.backoff ?? base.retries.backoff,
        }
      : base.retries,
  }
}
