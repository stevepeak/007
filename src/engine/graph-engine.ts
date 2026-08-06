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
