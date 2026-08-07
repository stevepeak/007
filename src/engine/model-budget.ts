// Time budgets for a model call, derived from the node's durable step timeout.
//
// The problem this exists to solve: on Cloudflare, the ONLY bound on an agent
// node used to be `step.do`'s timeout, which aborts the closure from OUTSIDE.
// No catch runs, no log line is written, nothing lands in `wf_run_step.error` —
// the node simply restarts from turn 1 and repeats every tool call. A stall was
// invisible by construction.
//
// So every bound is now enforced INSIDE the step, where it can be caught,
// logged, and attributed, and the durable timeout becomes an unreachable
// backstop rather than the primary mechanism. `STEP_TIMEOUT_SLACK_MS` is the
// margin that guarantees the in-process abort wins that race.
//
// The budget is DERIVED from the node's resolved step timeout rather than
// hard-coded, because any node may override that timeout via
// `execution.timeoutMs`. A node pinned to 60s against a hard-coded 12-minute
// budget would put us straight back to invisible external kills.

/**
 * Margin between the in-process total budget and the durable step timeout.
 * Wide enough to cover recording the failure and writing the node's feed after
 * the abort fires — that trailing work still happens inside the step.
 */
export const STEP_TIMEOUT_SLACK_MS = 3 * 60_000

/**
 * Ceiling for a single model round-trip. Observed latency is wildly variable —
 * mid-loop turns can land in ~6s while a long final answer (a coverage opinion
 * letter, against a 128K max-completion model) is the real tail. This is
 * calibrated to catch a *stalled* connection, not to police a slow one.
 */
export const MAX_ROUND_TRIP_MS = 8 * 60_000

/** Ceiling for one tool execution (knowledge-base search, document fetch). */
export const MAX_TOOL_MS = 90_000

/**
 * Provider-level retries inside ONE model call, on top of the first attempt.
 *
 * The AI SDK defaults to 2 (three attempts). An immediate second try genuinely
 * converts a 429 or a one-off 500; a third almost never does against a gateway
 * that is already failing, and each attempt costs a full request round-trip.
 * One retry keeps the cheap win and halves the worst case — which then
 * compounds with the node's own `step.do` retries, so the term counts twice.
 */
export const MODEL_MAX_RETRIES = 1

/**
 * Floor for the total budget, so a node with an aggressively short
 * `execution.timeoutMs` still gets a usable (if tight) window rather than a
 * zero/negative one.
 */
export const MIN_TOTAL_MS = 30_000

/**
 * What bounds one agent node's model work. `stepMs` and `toolMs` are handed to
 * the AI SDK's native per-round-trip and per-tool watchdogs; `totalMs` is
 * enforced by our own AbortController so an overrun is distinguishable from a
 * stall (they are treated differently — a stall retries, an overrun fails).
 */
export type ModelBudget = {
  /** The whole agent node: every turn, every tool call, start to finish. */
  totalMs: number
  /** One model round-trip. */
  stepMs: number
  /** One tool execution. */
  toolMs: number
}

/**
 * Derive a node's model budget from its resolved durable step timeout.
 *
 * The per-round-trip and per-tool ceilings are `min`-capped against the total,
 * never fractions of it: a node granted a generous total shouldn't imply that
 * any single round-trip may consume most of it, and a node granted a tight
 * total must not hand out sub-budgets larger than itself.
 */
export function modelBudgetFor(stepTimeoutMs: number): ModelBudget {
  const totalMs = Math.max(stepTimeoutMs - STEP_TIMEOUT_SLACK_MS, MIN_TOTAL_MS)
  return {
    totalMs,
    stepMs: Math.min(totalMs, MAX_ROUND_TRIP_MS),
    toolMs: Math.min(totalMs, MAX_TOOL_MS),
  }
}
