import type { ExecutableNode } from '../engine/scheduler'
import type { RunLogEntry, StreamSink } from '../engine/stream-sink'
import { createWfDb } from '../storage/client'
import { appendRunLog, countNodeBodyLogs } from '../storage/data'

import type { GraphWorkflowEnv } from './graph-workflow'
import { logRow } from './graph-workflow-dispatch-logs'
import type { RunCtx } from './graph-workflow-dispatch-run-ctx'

// The per-node feed writer.
//
// Every structured entry a node handler emits — agent reasoning, tool calls, an
// iteration's per-item ticks, our own info lines — has to go two places at once:
//
//   (a) persisted to `wf_run_log` IMMEDIATELY, because every consumer POLLS the
//       persisted feed. Without this a node is invisible until it finishes, which
//       for a ten-minute agent is the whole run.
//   (b) buffered, so the terminal `record:` rewrite can settle the node's full
//       feed in one idempotent write and restore anything (a) dropped.
//
// Both sinks below do exactly that and differ in ONE thing: where the row's
// ordinal comes from. That difference is not cosmetic — it is the difference
// between the two kinds of node — so it is the only parameter, and everything
// else is written once.

/**
 * A node's live feed writer: persist each entry, buffer it, forward it up.
 *
 * `nextOrdinal` is called once per entry, before it is buffered, and owns the
 * only thing that varies between a `run:`-step node and a self-stepping one. See
 * {@link runStepOrdinals} and {@link selfSteppingOrdinals} for which is which and
 * why.
 *
 * Writes are best-effort: a dropped progress line must never fail the node that
 * was merely narrating itself. The `record:` rewrite is the backstop.
 */
export function createNodeSink<TDeps, E extends GraphWorkflowEnv>(
  ctx: RunCtx<TDeps, E>,
  node: ExecutableNode,
  seq: number,
  bodyLogs: RunLogEntry[],
  nextOrdinal: () => number,
): StreamSink {
  const logDb = createWfDb(ctx.env.WF_DB)
  return {
    log: (entry) => {
      const e: RunLogEntry = {
        ...entry,
        ts: entry.ts ?? Date.now(),
        nodeId: entry.nodeId ?? node.id,
        nodeKind: entry.nodeKind ?? node.kind,
        sequence: entry.sequence ?? seq,
      }
      const ordinal = nextOrdinal()
      bodyLogs.push(e)
      void appendRunLog(logDb, {
        runId: ctx.p.workflowRunId,
        nodeId: node.id,
        ordinal,
        entry: logRow(node, seq, e),
      }).catch((err: unknown) => {
        ctx.logger.error('[wf] live log append failed', err)
      })
      return ctx.sink.log?.(e)
    },
  }
}

/**
 * Ordinals for a node running inside a `run:` step, seeded from what it already
 * wrote on an EARLIER ATTEMPT.
 *
 * `step.do` replays the whole closure, so a retry starts its rows in a fresh id
 * range rather than overwriting the previous attempt's account of what it was
 * doing when it died. Async because the base is a count out of `wf_run_log`; the
 * returned flag is what tells the caller to announce the restart.
 */
export async function runStepOrdinals<TDeps, E extends GraphWorkflowEnv>(
  ctx: RunCtx<TDeps, E>,
  node: ExecutableNode,
): Promise<{ nextOrdinal: () => number; isRetry: boolean }> {
  let ordinal = await countNodeBodyLogs(createWfDb(ctx.env.WF_DB), {
    runId: ctx.p.workflowRunId,
    nodeId: node.id,
  })
  return { nextOrdinal: () => ordinal++, isRetry: ordinal > 0 }
}

/**
 * Ordinals for a node that drives durable steps of its OWN — an iteration or a
 * workflow call (see `ownsItsDurableSteps`).
 *
 * There is no `run:` step to host its sink, so the sink is built in the
 * orchestrator body — and the body is NOT journaled, so every replay of the
 * instance re-emits these same lines. Keying each row to its position in the
 * buffer is what keeps a replay upserting onto the same slot instead of stacking
 * a second copy of the node's whole narration onto the feed. A replay refills
 * `bodyLogs` on the way past, so the `record:` rewrite settles those same slots.
 *
 * Without this the lines went to the run-level sink, which persists nothing — an
 * iteration's `Reading each recipe — ${n} in total.` was authored, emitted, and
 * dropped on the floor (ART-25).
 */
export function selfSteppingOrdinals(bodyLogs: RunLogEntry[]): () => number {
  return () => bodyLogs.length
}
