import type { NodeExecution } from '../engine/graph'

// The step policy every eval run's nodes are capped at, applied as a
// RUN-SCOPED override rather than baked into the graph: an eval may target a
// workflow the user published, whose declared execution policy is a property of
// their production graph and not of our harness.

/**
 * `timeoutMs: 7 min` derives (via `modelBudgetFor`, minus
 * `STEP_TIMEOUT_SLACK_MS`) a 4-minute in-process budget — comfortably above a
 * legitimate multi-turn eval cell, and far tighter than the 20-minute AI
 * default it would otherwise inherit. 7 is the practical floor: the slack is 3
 * minutes, so 5 would leave a 2-minute budget with no headroom for a
 * tool-calling sample.
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
  timeoutMs: 7 * 60_000,
}
