import { NonRetryableError } from 'cloudflare:workflows'

import {
  encodedByteLength,
  hasBlobRef,
  rehydrateBlobRefs,
  spillLargeLeaves,
} from '../engine/blob-ref'
import type { BlobSpillContext, WfSdkConfig } from '../engine/config'

/**
 * What a caller names: the boundary. `path` is filled in per payload by the
 * walk, since one output can spill several leaves.
 */
type BoundaryContext = Omit<BlobSpillContext, 'path'>

// Blob spill at the durable boundary.
//
// Cloudflare Workflows caps what a `step.do` may return, and what an event
// payload may carry, at 1 MiB each. Four values in this dispatcher approach one
// of those caps:
//
//   run:<node>          a node's output (both copies — recorded and scheduled)
//   iter:<node>:<i>     one iteration item's subgraph result
//   (the collection)    every item's result, gathered
//   callee event        a spawned callee's output, JSON-encoded onto the event
//
// The first two are spilled here. The other two need no write of their own: an
// iteration's collection is the list of its items' returns, so spilling the
// items is what keeps it small, and a callee's event payload carries the value
// its Output node resolved to — which is some node's output, already spilled at
// its own `run:` step if it was large.
//
// Any of them can exceed the cap on a large enough document, list, or agent
// synthesis. Until this hook existed the only protection was `extract_text`
// spilling its own text: every other producer crossed unguarded, and a run that
// tripped the cap failed with a runtime error naming neither the node nor the
// size.
//
// Every spill happens INSIDE the step whose boundary it protects, so the payload
// is written from the same closure that produced it and only the pointer is
// journaled. That also makes it replay-safe: a retried step re-runs the write to
// the same deterministic key (node id + path, both stable across attempts),
// overwriting rather than leaking a second object per attempt.

/**
 * Spill a string past this many bytes. Well under the 1 MiB step cap, so the
 * pointer, its preview, and the rest of the step envelope (the node's buffered
 * log entries, its meta) still fit.
 */
export const DEFAULT_SPILL_THRESHOLD_BYTES = 128 * 1024

/**
 * The size at which we stop trying and say so. Spilling replaces oversized
 * *strings*; a value can still be too big without containing a single big one —
 * a thousand medium fields, a wide iteration item — and that is the case
 * pointers cannot fix. Failing here names the node and the number, which is
 * strictly more than the runtime's own "step output too large" tells anyone.
 */
const HARD_CEILING_BYTES = 768 * 1024

/** Characters of the payload kept inline on the pointer for traces and UI. */
const SPILL_PREVIEW_CHARS = 2000

/**
 * Replace the oversized parts of `value` with blob pointers, then assert what's
 * left can actually cross the boundary named by `ctx`.
 *
 * A no-op when the host wired no `spillBlobRef` — the default, and why an SDK
 * consumer that never spills pays nothing for this beyond one property read.
 */
export async function spillAtBoundary<TDeps>(
  config: WfSdkConfig<TDeps>,
  deps: TDeps,
  ctx: BoundaryContext,
  value: unknown,
): Promise<unknown> {
  const spill = config.spillBlobRef
  if (!spill) return value
  const spilled = await spillLargeLeaves(value, {
    thresholdBytes: config.spillThresholdBytes ?? DEFAULT_SPILL_THRESHOLD_BYTES,
    previewChars: SPILL_PREVIEW_CHARS,
    write: ({ text, contentType, path }) =>
      spill({ text, contentType }, { ...ctx, path }, deps),
  })
  assertFitsBoundary(spilled, ctx)
  return spilled
}

function assertFitsBoundary(value: unknown, ctx: BoundaryContext): void {
  const bytes = encodedByteLength(value)
  // Unencodable — a cycle, a BigInt. Not a size problem, and the boundary
  // rejects it with a message about what it actually is.
  if (bytes === undefined || bytes <= HARD_CEILING_BYTES) return
  const where =
    ctx.itemIndex === undefined
      ? `Node ${ctx.nodeId}`
      : `Node ${ctx.nodeId}, item ${ctx.itemIndex},`
  throw new NonRetryableError(
    `${where} produced ${Math.round(bytes / 1024)} KiB of output, past the ${Math.round(
      HARD_CEILING_BYTES / 1024,
    )} KiB a workflow step can carry. Large text is spilled to blob storage automatically; this output is large because of how MANY values it holds, which spilling cannot fix. Narrow what the node returns, or split the work across more nodes.`,
  )
}

/**
 * Spill a node's two output copies, sharing one pass when they are the same
 * value — which they are for every node kind but the decision ones, since most
 * handlers return one object as both what downstream sees and what gets
 * recorded. Spilling twice would double the writes for every large output and,
 * worse, leave the trace pointing at a different object than the one the next
 * node reads.
 */
export async function spillNodeOutputs<TDeps>(
  config: WfSdkConfig<TDeps>,
  deps: TDeps,
  ctx: BoundaryContext,
  outputs: { schedulerOutput: unknown; recordedOutput: unknown },
): Promise<{ schedulerOutput: unknown; recordedOutput: unknown }> {
  if (!config.spillBlobRef) return outputs
  const scheduled = await spillAtBoundary(
    config,
    deps,
    ctx,
    outputs.schedulerOutput,
  )
  if (Object.is(outputs.schedulerOutput, outputs.recordedOutput)) {
    return { schedulerOutput: scheduled, recordedOutput: scheduled }
  }
  return {
    schedulerOutput: scheduled,
    recordedOutput: await spillAtBoundary(
      config,
      deps,
      ctx,
      outputs.recordedOutput,
    ),
  }
}

/**
 * Read a spilled value back for a consumer that cannot take a pointer.
 *
 * Nodes rehydrate their own inputs inside their own steps; this is for the one
 * place a value leaves the graph entirely — a run's delivered answer, which has
 * to satisfy the trigger's output contract (`{ text }` for chat) and reach the
 * host as a real value rather than a pointer only the SDK knows how to read.
 *
 * Deliberately NOT applied when the run is a spawned callee: its answer goes to
 * a parent that will pass it to another node, and that node rehydrates for
 * itself. Reading it back here would drag the payload onto the event boundary —
 * the exact crossing the pointer exists to avoid.
 *
 * Deps arrive as a thunk because building them is real work (a D1 client, a
 * vector-store client) and almost no answer has anything spilled in it. The
 * pointer scan is a walk of an in-hand value; the deps are only built once one
 * is actually found.
 */
export async function rehydrateAtBoundary<TDeps>(
  config: WfSdkConfig<TDeps>,
  getDeps: () => TDeps | Promise<TDeps>,
  value: unknown,
): Promise<unknown> {
  const resolve = config.resolveBlobRef
  if (!resolve || !hasBlobRef(value)) return value
  const deps = await getDeps()
  return await rehydrateBlobRefs(value, (ref) => resolve(ref, deps))
}
