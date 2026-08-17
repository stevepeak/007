import type { NodeExecution } from './graph-schema'

// How long a node is allowed to run, in ms — the author's declared intent,
// independent of which backend enforces it.
//
// This lives in the engine rather than in the Cloudflare backend because BOTH
// backends need it and they must not disagree. The durable backend hands it to
// `step.do` as a wall-clock timeout and derives the in-process model budget from
// it; the inline backend has no step to hand it to, so the budget is the ONLY
// bound it has. Same declared number, same meaning, one knob for the author.

/** LLM-ish nodes — long, since they wait on a provider. */
export const AI_NODE_TIMEOUT_MS = 20 * 60_000
/** Everything else — deterministic branches, tools, joins. */
export const DEFAULT_NODE_TIMEOUT_MS = 60_000

/** True for a node that runs a whole subgraph as one unit of execution. */
function isSubgraphContainer(kind: string): boolean {
  return kind === 'workflow' || kind === 'iteration'
}

/** The per-kind default before any `execution` override. */
export function defaultNodeTimeoutMs(kind: string): number {
  // `workflow` and `iteration` are CONTAINERS: each runs a whole subgraph —
  // usually several LLM nodes — as one unit, so they need the AI budget too. For
  // `iteration` the unit is ONE ITEM (the fan-out is many such units), which is
  // why the wide default is not multiplied by the item count.
  //
  // Omitting `iteration` here is not a smaller budget, it is a broken one: the
  // container's timeout is what the item subgraph's model budget derives from,
  // and 60s minus `STEP_TIMEOUT_SLACK_MS` floors at `MIN_TOTAL_MS`, so every
  // agent inside every iteration silently ran under a 30-second cap while its
  // enclosing step was allowed 20 minutes.
  return kind === 'agent' || isSubgraphContainer(kind)
    ? AI_NODE_TIMEOUT_MS
    : DEFAULT_NODE_TIMEOUT_MS
}

/**
 * A node's effective timeout: its `execution.timeoutMs`, else the kind default,
 * optionally capped by a RUN-SCOPED override.
 *
 * The override TIGHTENS ONLY. A run-level bound exists to cap what one run may
 * cost — an eval harness putting a ceiling on a wedged provider — so it must
 * never loosen a node whose author declared something stricter, and equally
 * must not be defeatable by an author who declared something looser. Hence the
 * `min`, with the KIND DEFAULT participating: a node with no `execution` at all
 * still inherits 20 minutes, and ignoring that would make the override a no-op
 * for exactly the nodes it most needs to bound.
 *
 * Only the inline backend consults the override. The durable backend
 * deliberately does not: threading it through `step.do` meant touching the
 * dispatch hot path of every production run to serve one caller, and evals run
 * inline anyway (see `buildAgentWrapperGraph`).
 */
export function resolveNodeTimeoutMs(
  node: {
    kind: string
    execution?: NodeExecution
  },
  override?: NodeExecution,
): number {
  const own = node.execution?.timeoutMs ?? defaultNodeTimeoutMs(node.kind)
  return override?.timeoutMs != null
    ? Math.min(own, override.timeoutMs)
    : own
}
