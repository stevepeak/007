import type { WorkflowStep } from 'cloudflare:workers'

// Cloudflare Workflows bills per STEP, not per run, and a graph's step count is
// nowhere near its node count: every node costs `enter:` + `run:` + `record:`,
// an iteration substitutes one `iter:<node>:<i>` per item, a durable callee
// substitutes `spawn:` + `await:`, and the run envelope adds ~8 more. Nothing
// recorded that number, so the billing line had no explanation.
//
// This counts ACTUAL `step.do` calls rather than deriving them from a formula
// (`nodes × 3 + items`). The formula is correct today and silently wrong the
// first time anyone adds a step; a proxy over the primitive cannot drift,
// because every existing and future call site is counted for free.
//
// REPLAY DETERMINISM: `run()` re-executes from the top on every wake and
// re-issues every step call — completed ones short-circuit from the journal,
// but the CALL still happens — so the counter re-accumulates to the identical
// value. This is the same property that makes `sequence` safe: it lives in the
// orchestrator and never crosses an opaque step boundary.

/** The step methods that bill. Everything else on `WorkflowStep` passes through. */
const COUNTED = new Set(['do', 'sleep', 'sleepUntil', 'waitForEvent'])

/**
 * Run-scoped tallies, accumulated in the orchestrator and read inside the run's
 * LAST step (`settle` on success, `record-failure` on the error path).
 */
export type RunCounters = {
  /** Billable `step.*` calls issued so far. */
  steps: number
  /** Top-level graph nodes the scheduler actually dispatched. */
  nodes: number
  /** Items executed across every iteration node — the main step multiplier. */
  iterationItems: number
  /** Nodes that ended `failed`. */
  failedNodes: number
}

export function createRunCounters(): RunCounters {
  return { steps: 0, nodes: 0, iterationItems: 0, failedNodes: 0 }
}

/**
 * Wrap a `WorkflowStep` so every billable call increments `counters.steps`.
 *
 * A Proxy rather than an explicit wrapper class: `do` carries four overloads
 * whose callback context types discriminate on the retry config, and restating
 * them would be a second contract to keep in sync with `@cloudflare/workers-types`.
 */
export function createCountingStep(
  step: WorkflowStep,
  counters: RunCounters,
): WorkflowStep {
  return new Proxy(step, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown
      if (typeof value !== 'function') return value
      const fn = value as (...args: unknown[]) => unknown
      if (!COUNTED.has(prop as string)) return fn.bind(target)
      return (...args: unknown[]) => {
        // Counted on CALL, not on completion: a step that throws was still
        // issued, still journaled, and still billed.
        counters.steps++
        return fn.apply(target, args)
      }
    },
  })
}
