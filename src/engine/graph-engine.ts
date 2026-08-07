import { z } from 'zod'

import { wfEngineSchema, type WfEngine } from './graph-schema'

// Reading the engine off a stored graph, deliberately WITHOUT the strict
// `workflowGraphSchema`.
//
// The engine is read at run-START, before the backend has loaded and validated
// anything — it is the choice of which backend to hand the run to. Running the
// full validator there would mean a graph that fails validation for an unrelated
// reason (a dangling ref, an unreachable Output) could never even reach the
// backend that reports the failure properly, turning a legible in-run error into
// an opaque one at dispatch. So this matches only the shape it needs — a node
// with `kind: 'trigger'` carrying a `config.engine` — and falls back to the
// schema default for anything it cannot read.

const engineProbeSchema = z.object({
  nodes: z.array(
    z.object({
      kind: z.string(),
      config: z.object({ engine: wfEngineSchema.optional() }).passthrough(),
    }),
  ),
})

/** The schema default — what a graph authored before the choice existed runs on. */
export const DEFAULT_WF_ENGINE: WfEngine = 'durable'

/**
 * Which backend a stored graph asks to run on. Returns {@link DEFAULT_WF_ENGINE}
 * when the graph has no trigger, no `engine`, or does not parse at all.
 */
export function resolveGraphEngine(graph: unknown): WfEngine {
  const parsed = engineProbeSchema.safeParse(graph)
  if (!parsed.success) return DEFAULT_WF_ENGINE
  const trigger = parsed.data.nodes.find((n) => n.kind === 'trigger')
  return trigger?.config.engine ?? DEFAULT_WF_ENGINE
}

const answerProbeSchema = z.object({
  nodes: z.array(
    z.object({
      kind: z.string(),
      config: z
        .object({
          source: z.object({ nodeId: z.string() }).partial().optional(),
        })
        .passthrough(),
    }),
  ),
})

/**
 * The ids of the nodes whose output IS the run's answer — the nodes each Output
 * node's `config.source` ref points at.
 *
 * This is what makes "stream the answer" precise instead of a guess. A graph may
 * contain several agents, and only one of them writes what the reader sees; the
 * author already said which by binding the Output. Knowing it at run START (not
 * at the end, when the value is finally read) is what lets the engine hand the
 * delta channel to exactly one node.
 *
 * A SET, not a single id, because multiple Outputs are legal — one per branch
 * arm. Only the arm that actually runs will ever emit, so handing the channel to
 * every candidate is safe.
 *
 * Empty when no Output names a source (an unbound Output is an author-time
 * error caught elsewhere); callers then simply stream nothing.
 */
export function resolveAnswerNodeIds(graph: unknown): Set<string> {
  const parsed = answerProbeSchema.safeParse(graph)
  if (!parsed.success) return new Set()
  const ids = new Set<string>()
  for (const node of parsed.data.nodes) {
    if (node.kind !== 'output') continue
    const nodeId = node.config.source?.nodeId
    if (nodeId) ids.add(nodeId)
  }
  return ids
}
