import type { NodeExecution } from '../engine/graph'

// The step policy every eval run's nodes are capped at, applied as a
// RUN-SCOPED override rather than baked into the graph: an eval may target a
// workflow the user published, whose declared execution policy is a property of
// their production graph and not of our harness.

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
 * A workflow-target eval whose author chose `engine: 'durable'` keeps that
 * engine's own retry policy; bounding it would mean threading this override
 * through the dispatch hot path of every production run, which is not worth it
 * for one caller. Such a run now merely takes longer to fail — it can no longer
 * fail invisibly, which was the actual defect.
 */
export const EVAL_NODE_EXECUTION: NodeExecution = {
  timeoutMs: 12 * 60_000,
}
