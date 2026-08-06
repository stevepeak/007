import type { NodeExecution } from './graph-schema'

// How long a node is allowed to run, in ms — the author's declared intent,
// independent of which backend enforces it.
//
// This lives in the engine rather than in the Cloudflare backend because BOTH
// backends need it and they must not disagree. The durable backend hands it to
// `step.do` as a wall-clock timeout and derives the in-process model budget from
// it; the inline backend has no step to hand it to, so the budget is the ONLY
// bound it has. Same declared number, same meaning, one knob for the author.

/** LLM-ish nodes (agent, workflow) — long, since they wait on a provider. */
export const AI_NODE_TIMEOUT_MS = 20 * 60_000
/** Everything else — deterministic branches, tools, joins. */
export const DEFAULT_NODE_TIMEOUT_MS = 60_000

/** The per-kind default before any `execution` override. */
export function defaultNodeTimeoutMs(kind: string): number {
  // A `workflow` node runs a whole callee subgraph (often several LLM nodes) in
  // one unit, so it gets the AI budget too.
  return kind === 'agent' || kind === 'workflow'
    ? AI_NODE_TIMEOUT_MS
    : DEFAULT_NODE_TIMEOUT_MS
}

/** A node's effective timeout: its `execution.timeoutMs`, else the kind default. */
export function resolveNodeTimeoutMs(node: {
  kind: string
  execution?: NodeExecution
}): number {
  return node.execution?.timeoutMs ?? defaultNodeTimeoutMs(node.kind)
}
