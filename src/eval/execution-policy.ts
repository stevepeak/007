import type { NodeExecution } from '../engine/graph'

// The step policy every eval run's nodes are capped at, applied as a
// RUN-SCOPED override rather than baked into the graph, so it also reaches a
// hidden wrapper that was cached long ago.

/**
 * `timeoutMs: 12 min` derives (via `modelBudgetFor`) a 9-minute in-process
 * budget. A slow reasoning model spends 30–50s a turn, so a ten-turn research
 * agent plus its final schema pass needs most of that; a tighter cap fails the
 * cell on our clock and the report blames the model. Still well under the
 * 20-minute AI default it would otherwise inherit, and under the
 * 15-minute `EVAL_WAIT_TIMEOUT_MS` the waiter gives it.
 *
 * Timeout only, no `retries`: agent-eval wrappers run on the INLINE engine
 * (`buildAgentWrapperGraph`), which has no `step.do` and therefore no step
 * retries to suppress — the in-process model budget is the only bound there.
 */
export const EVAL_NODE_EXECUTION: NodeExecution = {
  timeoutMs: 12 * 60_000,
}
