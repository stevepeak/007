import type { AggregateNode } from '../graph'

export type AggregateNodeResult = {
  /** The collected list — one element per incoming producer. */
  output: unknown[]
  meta: { count: number }
}

export type ExecuteAggregateNodeDeps = {
  node: AggregateNode
  input: unknown
}

// The Aggregate node is a wait-for-all fan-in join. All of the collection logic
// lives in the Scheduler: readiness stays the default all-predecessors (`every`)
// rule, and its resolved input is already the ordered array of upstream outputs
// (one element per incoming producer, in edge-declaration order). By the time
// execution reaches here the list is assembled, so the node is a pure
// pass-through — it forwards that list on unchanged, exactly like the Race node
// forwards its single winner. A defensive `[]` covers the degenerate no-input
// case (the scheduler never schedules a node with no live edges, but keeping the
// contract total means downstream `list` consumers never see a non-array).
export function executeAggregateNode(
  deps: ExecuteAggregateNodeDeps,
): Promise<AggregateNodeResult> {
  const list = Array.isArray(deps.input) ? deps.input : []
  return Promise.resolve({ output: list, meta: { count: list.length } })
}
