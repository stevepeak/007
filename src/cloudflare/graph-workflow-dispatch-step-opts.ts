import type { WorkflowStepConfig } from 'cloudflare:workers'

import type { NodeExecution } from '../engine/graph'

// Per-kind step.do retry/timeout policy defaults. LLM nodes get longer, retried
// steps. A node's optional `execution` policy overrides these field-by-field.
//
// The timeout is WALL CLOCK, and Cloudflare puts no ceiling on it (only CPU
// time per step is capped, and an agent node spends its life waiting on the
// provider, not burning CPU).
//
// This is now a BACKSTOP, not the primary bound. An agent node enforces its own
// budget in-process (see `engine/model-budget.ts`), derived from this value
// minus `STEP_TIMEOUT_SLACK_MS`, so an overrun surfaces as a catchable, logged
// error instead of the runtime killing the closure from outside — which
// produced no catch, no log line, and a silent restart from turn 1.
//
// Timeouts are expressed as a NUMBER OF MS rather than Cloudflare's duration
// strings: `step.do` accepts both, and numbers are what `resolveStepTimeoutMs`
// below needs in order to derive a budget without parsing '15 minutes'.
export const AI_STEP_OPTS = {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
  timeout: 20 * 60_000,
} as const
export const DEFAULT_STEP_OPTS = {
  retries: { limit: 2, delay: '3 seconds', backoff: 'exponential' },
  timeout: 60_000,
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

/**
 * The node's effective step timeout in ms — the same value `stepOptsFor` hands
 * Cloudflare, before it becomes a `WorkflowStepConfig`. This is the input the
 * in-process model budget derives from, so the two can never disagree about how
 * long a node is allowed to run.
 */
export function resolveStepTimeoutMs(node: {
  kind: string
  execution?: NodeExecution
}): number {
  return node.execution?.timeoutMs ?? kindDefaultOpts(node.kind).timeout
}
