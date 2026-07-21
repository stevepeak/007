import { resolveBinding } from '../binding'
import type { IterationNode, WorkflowGraph } from '../graph'
import { runNode, type RunNodeContext } from '../run-node'
import type { RunRecorder } from '../run-recorder'
import { Scheduler, WorkflowStalledError } from '../scheduler'

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
    items: IterationItemStatus[]
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
    let result
    try {
      result = await runNode(instruction, {
        ...ctx,
        // Per-item output cache — ref bindings inside the subgraph resolve
        // against this run's nodes only.
        nodeOutputs: scheduler.getOutputs(),
      })
    } catch (err) {
      if (rec) {
        await rec({
          nodeId: node.id,
          nodeKind: node.kind,
          input,
          status: 'failed',
          error: messageOf(err),
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
        branchResult: result.branchResult
          ? { result: result.branchResult, reasoning: result.branchReasoning ?? '' }
          : null,
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
  const { source } = node.config
  if (!source) {
    throw new Error(
      `Iteration node ${node.id} has no list selected — pick an upstream list to loop over.`,
    )
  }
  const value = resolveBinding(source, nodeOutputs, {
    nodeId: node.id,
    name: 'list',
  })
  if (!Array.isArray(value)) {
    const where = `${source.nodeId}${source.path ? `.${source.path}` : ' (whole output)'}`
    throw new Error(
      `Iteration node ${node.id} expected an array at ${where} but received ${value === undefined ? 'undefined' : typeof value}.`,
    )
  }
  return value
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
}): Promise<IterationResult> {
  const { node, list: arr, runItem } = args
  const { concurrency, stopOnError } = node.config

  const total = arr.length
  const results = new Array<unknown>(total)
  const statuses = new Array<IterationItemStatus | undefined>(total)
  const meta = { total, concurrency, stopOnError } as const

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
      try {
        results[index] = await runItem(arr[index], index)
        statuses[index] = { index, status: 'completed' }
      } catch (err) {
        statuses[index] = { index, status: 'failed', error: messageOf(err) }
        results[index] = { __iterationError: messageOf(err) }
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
      : new Error(messageOf(firstError))
  }

  const items = statuses.filter(
    (s): s is IterationItemStatus => s !== undefined,
  )
  return { results, meta: { ...meta, items } }
}
