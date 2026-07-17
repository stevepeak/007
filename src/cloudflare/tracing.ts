import * as Sentry from '@sentry/cloudflare'

// Per-node Sentry tracing for the durable backend. Worker-only (imports
// `@sentry/cloudflare`), so it lives beside `graph-workflow.ts` in the
// `/runtime` subpath and is never dragged into the import-safe barrel.
//
// The outer `GraphWorkflow` is already wrapped by `instrumentWorkflowWithSentry`
// in the host worker, so a Sentry client + async context are active during
// `run()`. But Cloudflare Workflows hibernate between `step.do` calls, and the
// ambient trace context does not reliably survive that — so we do NOT trust it
// to span the whole run. Instead each node's span explicitly *continues* a trace
// seeded with the run's own `traceId`, which groups every node into ONE
// distributed trace and gives us a deterministic id for the deep-link.
//
// Every Sentry call here is a safe no-op when no client is initialised (the
// in-process eval/test backend never imports this module at all), so callers
// need no guard.

// Deterministic 16-hex span id from a seed. Replay-safe: the same node+sequence
// always yields the same id, so a hibernated/retried run doesn't mint divergent
// spans. Two FNV-1a passes over the seed, concatenated to 16 hex chars.
function spanIdFromSeed(seed: string): string {
  let h1 = 0x811c9dc5
  let h2 = (0x811c9dc5 ^ 0x5bd1e995) >>> 0
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x01000193) >>> 0
  }
  const hex = (n: number) => n.toString(16).padStart(8, '0')
  return (hex(h1) + hex(h2)).slice(0, 16)
}

export type NodeSpanInfo = {
  /** The run's stable 32-hex trace id (undefined for pre-tracing runs). */
  traceId?: string
  runId: string
  nodeId: string
  nodeKind: string
  sequence: number
}

/**
 * Run `fn` inside a Sentry span describing one node's execution, pinned to the
 * run's trace when a `traceId` is present.
 */
export async function withNodeSpan<T>(
  info: NodeSpanInfo,
  fn: () => Promise<T>,
): Promise<T> {
  const attributes: Record<string, string | number> = {
    'wf.run_id': info.runId,
    'wf.node_id': info.nodeId,
    'wf.node_kind': info.nodeKind,
    'wf.sequence': info.sequence,
  }
  if (info.traceId) attributes['wf.trace_id'] = info.traceId

  const runSpan = async (): Promise<T> =>
    await Sentry.startSpan(
      {
        name: `wf.node ${info.nodeKind} · ${info.nodeId.slice(0, 8)}`,
        op: 'wf.node',
        attributes,
      },
      fn,
    )

  if (!info.traceId) return await runSpan()

  // A synthetic, sampled `sentry-trace` header pins this span's trace to the
  // run's id. Every node continues the same trace id → one grouped trace.
  const spanId = spanIdFromSeed(
    `${info.traceId}:${info.nodeId}:${info.sequence}`,
  )
  return await Sentry.continueTrace(
    { sentryTrace: `${info.traceId}-${spanId}-1`, baggage: undefined },
    runSpan,
  )
}
