import { describeNode, resolveBinding } from '../binding'
import {
  ITERATION_MAX_ITEMS_FALLBACK,
  type IterationNode,
  type WorkflowGraph,
} from '../graph'
import { emitNodeProgress } from '../node-progress'
import {
  errorMessage,
  runNode,
  type NodeRunResult,
  type RunNodeContext,
} from '../run-node'
import { recordedBranchResult, type RunRecorder } from '../run-recorder'
import { Scheduler, WorkflowStalledError } from '../scheduler'
import type { StreamSink } from '../stream-sink'

// The iteration node fans a list out over an embedded subgraph: the subgraph
// runs once per element, the runs proceed in parallel up to a concurrency bound,
// and the node's output is the ordered collection of per-item results. This
// module owns two pure pieces:
//
//   • `executeSubgraph` — run the subgraph for ONE item, inline, via a nested
//     Scheduler + runNode loop. The item is the subgraph's trigger output.
//   • `runIteration` — resolve the array, drive concurrency + stop-on-error +
//     ordered collection. HOW one item runs (inline vs. a durable `step.do`) is
//     supplied by the caller as `runItem`, mirroring the engine's "pure core,
//     backend-supplied durability" split.
//
// The iteration is persisted as a single run-step (output = the collection,
// meta = per-item summaries). When a `SubgraphRecorder` is supplied,
// `executeSubgraph` ALSO records each inner node once per item — stamped with
// `parentNodeId` (the container) + `itemIndex` — so the run viewer can drill
// into any one item's per-node trace. Backends supply the recorder; the pure
// core stays unaware of where the rows land.

/** Marker stored in the results array for an item whose subgraph threw when
 * `stopOnError` is false, so positions stay aligned with the input list. */
export type IterationErrorPlaceholder = { __iterationError: string }

export type IterationItemStatus =
  | { index: number; status: 'completed' }
  | { index: number; status: 'failed'; error: string }
  | { index: number; status: 'skipped' }

export type IterationResult = {
  /** One entry per input item, in order. A failed item (when not stopping on
   * error) carries an {@link IterationErrorPlaceholder}. */
  results: unknown[]
  meta: {
    total: number
    concurrency: number
    stopOnError: boolean
    /** The fan-out bound in force for this run — the author's `maxItems`, or the
     * permissive fallback for a version published before bounds existed. Recorded
     * so a run shows how much headroom a loop had, not just how wide it went. */
    limit: number
    items: IterationItemStatus[]
  }
}

/**
 * Records each inner node of ONE iteration item, so the run viewer can drill
 * into that item's per-node trace. The `recorder` is the same seam the backends
 * use for top-level steps; `parentNodeId`/`itemIndex` scope the rows to this
 * container + item. Sequence numbers are local to the item (0-based), which is
 * enough to order one item's own timeline.
 */
export type SubgraphRecorder = {
  recorder: RunRecorder
  parentNodeId: string
  itemIndex: number
}

/**
 * Run an iteration node's subgraph for a single item and return the value its
 * Output node forwards. A fresh {@link Scheduler} (and fresh node-output cache)
 * is created per item so items never see each other's intermediate outputs; the
 * item is seeded as the subgraph trigger's output (the `iteration_item` trigger
 * is identity). The subgraph is strictly re-validated here — a structurally
 * broken subgraph fails the item rather than the parent parse.
 *
 * When `record` is supplied, every inner node (plus the trigger and output) is
 * persisted as a scoped run-step; a failing node records its failed step before
 * the error propagates so the item's break point is inspectable.
 */
export async function executeSubgraph<TDeps>(
  subgraph: WorkflowGraph,
  item: unknown,
  ctx: RunNodeContext<TDeps>,
  record?: SubgraphRecorder,
): Promise<unknown> {
  const scheduler = new Scheduler(subgraph)
  scheduler.seedTrigger(item)

  // Local, per-item sequence + a thin wrapper that stamps the container/item
  // scope onto every row. Omitted entirely when no recorder is wired.
  let seq = 0
  const rec = record
    ? (args: Omit<Parameters<RunRecorder['record']>[0], 'sequence'>) =>
        record.recorder.record({
          ...args,
          parentNodeId: record.parentNodeId,
          itemIndex: record.itemIndex,
          sequence: seq++,
        })
    : null

  // The subgraph trigger is identity — its output IS the item.
  if (rec) {
    await rec({
      nodeId: scheduler.trigger.id,
      nodeKind: 'trigger',
      input: item,
      status: 'completed',
      output: item,
    })
  }

  while (true) {
    const instruction = scheduler.next()
    if (instruction.type === 'stall') {
      throw new WorkflowStalledError()
    }
    if (instruction.type === 'output') {
      if (rec) {
        await rec({
          nodeId: instruction.nodeId,
          nodeKind: 'output',
          input: instruction.output,
          status: 'completed',
          output: instruction.output,
        })
      }
      return instruction.output
    }
    const { node, input } = instruction
    let result: NodeRunResult
    // Bracket the real execution so each per-item step's Speed reflects actual
    // work. These run inline (no step.do), so wall-clock here is exact.
    const startedAt = new Date()
    try {
      result = await runNode(instruction, {
        ...ctx,
        // Per-item output cache — ref bindings inside the subgraph resolve
        // against this run's nodes only.
        nodeOutputs: scheduler.getOutputs(),
        // Record exactly one level deep. A nested iteration inside this subgraph
        // still runs, but doesn't record its own inner steps — those would key
        // on the same (nodeId, parentNodeId, itemIndex) across every outer item
        // and clobber each other, and the run viewer only drills one level in.
        subStepRecorder: undefined,
      })
    } catch (err) {
      if (rec) {
        await rec({
          nodeId: node.id,
          nodeKind: node.kind,
          input,
          status: 'failed',
          error: errorMessage(err),
          startedAt,
          finishedAt: new Date(),
        })
      }
      throw err
    }
    if (rec) {
      await rec({
        nodeId: node.id,
        nodeKind: node.kind,
        input,
        status: 'completed',
        output: result.recordedOutput,
        meta: result.meta,
        branchResult: recordedBranchResult(result),
        startedAt,
        finishedAt: new Date(),
      })
    }
    scheduler.report(node.id, {
      output: result.schedulerOutput,
      branchResult: result.branchResult,
    })
  }
}

/**
 * Resolve the array an iteration loops over. The list is a `ref` into an upstream
 * node's output (`node.config.source`), resolved against the run's global
 * node-output map — NOT read out of a forwarded input, so an iteration can name
 * any producer directly (e.g. the tool upstream of a Branch it sits behind).
 * Throws a clear error when no list is selected or the ref doesn't point at an
 * array. Backends call this where they hold the outputs map, then hand the array
 * to {@link runIteration}.
 */
export function resolveIterationList(
  node: IterationNode,
  nodeOutputs: Map<string, unknown>,
): unknown[] {
  const self = describeNode(nodeOutputs, node.id)
  const { source } = node.config
  if (!source) {
    throw new Error(
      `${self} has no list selected — pick an upstream list to loop over.`,
    )
  }
  const value = resolveBinding(source, nodeOutputs, {
    nodeId: node.id,
    name: 'list',
  })
  if (!Array.isArray(value)) {
    const producer = describeNode(nodeOutputs, source.nodeId)
    const where = source.path
      ? `${producer}.${source.path}`
      : `${producer} (whole output)`
    throw new Error(
      `${self} expected an array at ${where} but received ${value === undefined ? 'undefined' : typeof value}.`,
    )
  }
  return value
}

/**
 * The most items this node may fan out over at run time.
 *
 * The author's declared `maxItems` when there is one — including a value above
 * the mode's ceiling, which the Issues panel already flagged at authoring time
 * and which this deliberately does NOT clamp: a fence that quietly enforces a
 * different number than the one in the editor is worse than a loud, visible
 * disagreement. A node with no bound at all can only be an already-published
 * version (the publish backfill writes one into everything else), so it falls
 * back to a permissive cap that stops a runaway without retroactively failing a
 * workflow that has always looped over more than a fresh node would allow.
 */
export function iterationItemLimit(node: IterationNode): number {
  return node.config.maxItems ?? ITERATION_MAX_ITEMS_FALLBACK
}

/**
 * A list that blew past its node's `maxItems` fence. Its own class so a backend
 * can tell "this list is too long" (never worth retrying — the same list comes
 * back) apart from an item that failed for a transient reason.
 */
export class IterationTooManyItemsError extends Error {
  constructor(
    readonly nodeId: string,
    readonly total: number,
    readonly limit: number,
    message: string,
  ) {
    super(message)
    this.name = 'IterationTooManyItemsError'
  }
}

/**
 * Drive an iteration node: run each element of `list` through `runItem` under a
 * bounded worker pool honoring `concurrency`, and collect the results in order.
 * The caller resolves `list` via {@link resolveIterationList}.
 *
 *   • `stopOnError: true`  — the first item failure aborts the remaining
 *     not-yet-started items and rethrows, failing the whole node (consistent
 *     with every other node's error contract).
 *   • `stopOnError: false` — a failed item is recorded, its slot filled with an
 *     {@link IterationErrorPlaceholder}, and the others run to completion.
 */
export async function runIteration(args: {
  node: IterationNode
  list: unknown[]
  runItem: (item: unknown, index: number) => Promise<unknown>
  /** When present AND the node's `informUser` is `static`, emit the author's
   * note once (with `${n}` = the item count) followed by a `Processing item i of
   * n` line as each item starts. Live signal only — the durable per-item trace
   * is the recorder's job. An `off` iteration says nothing, exactly like every
   * other node kind. */
  sink?: StreamSink
  /** The run's prompt variables, for interpolating the note. The iteration's own
   * built-ins (`n`/`total`) are layered on top. */
  promptVariables?: Record<string, unknown>
}): Promise<IterationResult> {
  const { node, list: arr, runItem, sink, promptVariables } = args
  const { concurrency, stopOnError } = node.config

  const limit = iterationItemLimit(node)
  const total = arr.length
  const results = new Array<unknown>(total)
  const statuses = new Array<IterationItemStatus | undefined>(total)
  const meta = { total, concurrency, stopOnError, limit } as const

  // The node's own user-facing line, emitted HERE rather than at dispatch
  // because this is the first point at which the item count exists — that's the
  // whole reason iteration is exempt from `emitNodeStartProgress`. Built-ins are
  // spread last so a run variable that happens to be named `n` can't shadow the
  // count the author is asking for. Emitted before the empty-list return below,
  // so a zero-item run still says "Processing 0 recipes…" instead of going
  // silent — an empty list is a result the user wants to see, not a non-event.
  const announce = node.informUser.mode === 'static'
  if (announce) {
    emitNodeProgress(sink, node, { ...promptVariables, n: total, total })
  }

  // How wide this fan-out turned out to be, on the dev feed unconditionally —
  // `announce` is the author's choice about what an END USER sees, and the size
  // of a list is exactly the thing whoever is reading a run needs whether or not
  // the author opted into narration. Emitted BEFORE the fence below so an
  // oversized list is a visible number in the run viewer rather than only an
  // error message about one.
  void sink?.log?.({
    level: 'info',
    message: `List resolved to ${total} item${total === 1 ? '' : 's'} (limit ${limit}).`,
    nodeId: node.id,
    nodeKind: 'iteration',
  })

  // The fence. Fail loudly and BEFORE any item starts: truncating would hand
  // back a plausible-looking partial collection that no downstream node — and no
  // reader of the run — could tell from a complete one, and running the first
  // `limit` items would spend the very budget the bound exists to protect.
  if (total > limit) {
    throw new IterationTooManyItemsError(
      node.id,
      total,
      limit,
      `Iteration "${node.label}" resolved a list of ${total} items, above its limit of ${limit}. ` +
        `Nothing was run. Narrow the list upstream, or raise the limit on this node if ${total} items is expected.`,
    )
  }

  if (total === 0) {
    return { results: [], meta: { ...meta, items: [] } }
  }

  // Shared cursor: workers pull the next index off it. Index assignment order is
  // deterministic, which keeps durable per-item step names stable across replay.
  let cursor = 0
  let aborted = false
  let firstError: unknown = null

  const worker = async (): Promise<void> => {
    while (!aborted) {
      const index = cursor
      if (index >= total) return
      cursor = index + 1
      if (announce) {
        void sink?.log?.({
          level: 'progress',
          message: `Processing item ${index + 1} of ${total}`,
          nodeId: node.id,
          nodeKind: 'iteration',
        })
      }
      try {
        results[index] = await runItem(arr[index], index)
        statuses[index] = { index, status: 'completed' }
      } catch (err) {
        statuses[index] = { index, status: 'failed', error: errorMessage(err) }
        results[index] = { __iterationError: errorMessage(err) }
        if (stopOnError) {
          aborted = true
          if (firstError === null) firstError = err
          return
        }
      }
    }
  }

  // `allSettled` so a throwing worker can't drop the results other workers have
  // already written; failures surface through `statuses`/`firstError` instead.
  await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, total) }, () => worker()),
  )

  if (stopOnError && firstError !== null) {
    for (let i = 0; i < total; i++) {
      if (statuses[i] === undefined)
        statuses[i] = { index: i, status: 'skipped' }
    }
    throw firstError instanceof Error
      ? firstError
      : new Error(errorMessage(firstError))
  }

  const items = statuses.filter(
    (s): s is IterationItemStatus => s !== undefined,
  )
  return { results, meta: { ...meta, items } }
}
