import type { WorkflowStepConfig } from 'cloudflare:workers'

import type { NodeExecution } from '../engine/graph'

// Per-kind step.do retry/timeout policy defaults. LLM nodes get longer, retried
// steps. A node's optional `execution` policy overrides these field-by-field.
//
// The timeout is WALL CLOCK, and Cloudflare puts no ceiling on it (only CPU
// time per step is capped, and an agent node spends its life waiting on the
// provider, not burning CPU). So this number needs to cover the SLOWEST
// legitimate run, not the typical one — an agent that overruns it is killed
// mid-flight and the whole node restarts from turn 1, repeating every tool
// call. That failure is invisible from inside the step: the runtime aborts the
// closure externally, so no catch runs and no error is ever raised.
//
// 3 minutes was far too tight — a tool-calling research agent (15 turns, each a
// full model round-trip on a reasoning model) routinely runs 4-6 minutes and
// was being killed and restarted every single time. 15 minutes leaves real
// headroom; a node that needs more should say so via `execution.timeoutMs`.
export const AI_STEP_OPTS = {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
  timeout: '15 minutes',
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
