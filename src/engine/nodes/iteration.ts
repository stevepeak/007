import { resolvePath } from '../binding'
import type { IterationNode, WorkflowGraph } from '../graph'
import { runNode, type RunNodeContext } from '../run-node'
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
// Neither threads a recorder: in this version a whole iteration is persisted as
// a single run-step (output = the collection, meta = per-item summaries); inner
// sub-node steps are not individually recorded.

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
 * Run an iteration node's subgraph for a single item and return the value its
 * Output node forwards. A fresh {@link Scheduler} (and fresh node-output cache)
 * is created per item so items never see each other's intermediate outputs; the
 * item is seeded as the subgraph trigger's output (the `iteration_item` trigger
 * is identity). The subgraph is strictly re-validated here — a structurally
 * broken subgraph fails the item rather than the parent parse.
 */
export async function executeSubgraph<TDeps>(
  subgraph: WorkflowGraph,
  item: unknown,
  ctx: RunNodeContext<TDeps>,
): Promise<unknown> {
  const scheduler = new Scheduler(subgraph)
  scheduler.seedTrigger(item)

  while (true) {
    const instruction = scheduler.next()
    if (instruction.type === 'stall') {
      throw new WorkflowStalledError()
    }
    if (instruction.type === 'output') {
      return instruction.output
    }
    const result = await runNode(instruction, {
      ...ctx,
      // Per-item output cache — ref bindings inside the subgraph resolve against
      // this run's nodes only.
      nodeOutputs: scheduler.getOutputs(),
    })
    scheduler.report(instruction.node.id, {
      output: result.schedulerOutput,
      branchResult: result.branchResult,
    })
  }
}

/**
 * Drive an iteration node: resolve the array at `itemsPath`, run each item
 * through `runItem` under a bounded worker pool honoring `concurrency`, and
 * collect the results in input order.
 *
 *   • `stopOnError: true`  — the first item failure aborts the remaining
 *     not-yet-started items and rethrows, failing the whole node (consistent
 *     with every other node's error contract).
 *   • `stopOnError: false` — a failed item is recorded, its slot filled with an
 *     {@link IterationErrorPlaceholder}, and the others run to completion.
 */
export async function runIteration(args: {
  node: IterationNode
  input: unknown
  runItem: (item: unknown, index: number) => Promise<unknown>
}): Promise<IterationResult> {
  const { node, input, runItem } = args
  const { itemsPath, concurrency, stopOnError } = node.config

  // An unset `itemsPath` (author never picked a list) resolves the whole input,
  // same as the deliberate '' selection.
  const arr = resolvePath(input, itemsPath ?? '')
  if (!Array.isArray(arr)) {
    const where = itemsPath ? ` at '${itemsPath}'` : ''
    throw new Error(
      `Iteration node ${node.id} expected an array${where} but received ${arr === undefined ? 'undefined' : typeof arr}.`,
    )
  }

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
      if (!statuses[i]) statuses[i] = { index: i, status: 'skipped' }
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
