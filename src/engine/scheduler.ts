import {
  workflowGraphSchema,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
} from './graph'

// The Scheduler is the runtime-agnostic heart of workflow execution. It owns
// the graph walk — which node is ready next, how branches route, how inputs
// are resolved, and when an Output terminates the run — but performs NO I/O:
// no LLM calls, no recorder writes, no `step.do`. A backend (the in-process
// `executor.ts` or the Cloudflare `GraphWorkflow`) pulls instructions out of
// `next()`, executes them however it likes (inline await vs durable step.do),
// and feeds results back via `report()`.
//
// Keeping this pure is what lets one graph schema run on two backends without
// the walk semantics drifting between them. It also makes the walk unit
// testable without mocking AI SDK / Cloudflare bindings.

// Trigger/Output are engine-managed bookends; Note is a portless canvas
// annotation with no incoming edges, so `isReady` never selects it. None of
// the three is ever an executable instruction.
export type ExecutableNode = Exclude<
  WorkflowNode,
  { kind: 'trigger' | 'output' | 'note' }
>

/** A node the backend must execute, with its resolved input. */
export type ExecuteInstruction = {
  type: 'execute'
  node: ExecutableNode
  input: unknown
}

/** One executable node + its resolved input, as carried in a batch. */
export type BatchItem = { node: ExecutableNode; input: unknown }

/**
 * Every currently-ready node, to run concurrently. For ordinary work nodes the
 * ready-set is an antichain — a node is ready only once ALL its predecessors are
 * `completed`, so no two have an edge between them and they run safely in
 * parallel. A `race` node is the one exception: it's ready on its FIRST completed
 * predecessor, so it can share a batch with a still-running predecessor. That's
 * harmless — its input is resolved from already-completed edges only and it fires
 * exactly once (a completed node is never re-selected), so the concurrency is
 * still safe; the not-yet-done predecessor's result is simply ignored.
 */
export type BatchExecuteInstruction = {
  type: 'execute'
  nodes: BatchItem[]
}

export type BatchInstruction =
  BatchExecuteInstruction | OutputInstruction | StallInstruction

/** The run has reached a terminal Output node. */
export type OutputInstruction = {
  type: 'output'
  nodeId: string
  output: unknown
}

/** No node is ready and no Output is reachable — the graph is malformed. */
export type StallInstruction = { type: 'stall' }

export type SchedulerInstruction =
  ExecuteInstruction | OutputInstruction | StallInstruction

export type ReportResult = {
  /** Whatever the node produced — becomes its `nodeOutputs` entry. */
  output: unknown
  /** Only for decision nodes (branch/switch): the decision that routes
   * outgoing edges — 'yes'|'no' for binary nodes, a case key or 'default' for a
   * switch. Matched against `edge.condition`. */
  branchResult?: string
}

// Soft safety bound — graphs that loop or stall hit this rather than the CF
// Workflows runtime ceiling. 256 is well above any realistic graph.
const HARD_NODE_BUDGET = 256

export class WorkflowStalledError extends Error {
  constructor() {
    super(
      'Workflow stalled — no executable node and no reachable output. Check that all paths lead to an Output node.',
    )
    this.name = 'WorkflowStalledError'
  }
}

export class WorkflowBudgetError extends Error {
  constructor(budget: number) {
    super(`Workflow exceeded the ${budget}-node execution budget.`)
    this.name = 'WorkflowBudgetError'
  }
}

export class Scheduler {
  readonly graph: WorkflowGraph
  readonly trigger: Extract<WorkflowNode, { kind: 'trigger' }>

  private readonly incoming = new Map<string, WorkflowEdge[]>()
  // Ids of `race` nodes — the first-to-finish join. They flip readiness from the
  // default all-predecessors (`every`) rule to any-predecessor (`some`), so we
  // only need the id set, not the full node map.
  private readonly raceIds = new Set<string>()
  // Ids of `aggregate` nodes — the wait-for-all fan-in join. They keep the
  // default `every` readiness (unlike race) but shape their resolved input into
  // an ordered list rather than the default single-value / keyed-object form.
  private readonly aggregateIds = new Set<string>()

  private readonly completed = new Set<string>()
  private readonly branchResults = new Map<string, string>()
  private readonly nodeOutputs = new Map<string, unknown>()
  private nodesFired = 0

  constructor(rawGraph: unknown) {
    this.graph = workflowGraphSchema.parse(rawGraph)
    const trigger = this.graph.nodes.find((n) => n.kind === 'trigger')
    if (!trigger) {
      // Already caught by superRefine, but the type narrowing needs this.
      throw new Error('Graph has no trigger node.')
    }
    this.trigger = trigger
    for (const n of this.graph.nodes) {
      if (n.kind === 'race') {
        this.raceIds.add(n.id)
      }
      if (n.kind === 'aggregate') {
        this.aggregateIds.add(n.id)
      }
    }
    for (const e of this.graph.edges) {
      const list = this.incoming.get(e.target)
      if (list) {
        list.push(e)
      } else {
        this.incoming.set(e.target, [e])
      }
    }
  }

  /**
   * Seed the trigger's output. The trigger "executes" instantly — its output
   * is the validated trigger input. The backend records it as a step; here we
   * only mark state so downstream readiness resolves.
   */
  seedTrigger(output: unknown): void {
    this.completed.add(this.trigger.id)
    this.nodeOutputs.set(this.trigger.id, output)
  }

  /**
   * The node-output cache, used by tool arg ref resolution. Returned as the
   * live map (engine-internal); callers read from it and must not mutate it.
   */
  getOutputs(): Map<string, unknown> {
    return this.nodeOutputs
  }

  /**
   * Whether any decision node (branch/switch) has recorded a routing
   * result. Lets a backend tell an intentional dead-end apart from a broken
   * graph on `stall`: a stall *after* a decision fired means its taken arm has
   * no outgoing edge — the path "fizzles out" and the run ends with no output.
   * A stall with no decision ever fired is a genuinely unreachable Output.
   */
  hasRoutedDecision(): boolean {
    return this.branchResults.size > 0
  }

  private isEdgeAlive = (e: WorkflowEdge): boolean => {
    if (!this.completed.has(e.source)) {
      return false
    }
    // A conditioned edge routes: it's alive only when its source reported a
    // matching decision. Branch/switch condition every outgoing edge; a YES/NO
    // (boolean) agent conditions its yes/no edges but can also feed plain
    // (unconditioned) edges as a pure data producer — those always flow. A
    // non-decision source never reports a result, so a stray condition stays
    // dead (validation rejects that shape at author time).
    if (e.condition != null) {
      return e.condition === this.branchResults.get(e.source)
    }
    return true
  }

  private isReady(nodeId: string): boolean {
    if (this.completed.has(nodeId)) {
      return false
    }
    const inc = this.incoming.get(nodeId) ?? []
    if (inc.length === 0) {
      // only the trigger has 0 incoming, already done
      return false
    }
    // A `race` node fires as soon as the FIRST predecessor completes (any live
    // incoming edge), rather than waiting for every predecessor. This is the
    // same `some` readiness the Output bookend uses — a race is essentially an
    // internal, non-terminal Output that the run continues past.
    if (this.raceIds.has(nodeId)) {
      return inc.some(this.isEdgeAlive)
    }
    return inc.every(this.isEdgeAlive)
  }

  // The Output node forwards the result of whichever upstream node actually
  // executed and connected into it via a live edge. Multiple Output nodes are
  // legal (one per branch arm); a single Output with multiple incoming edges
  // (branch arms converging) also works — exactly one incoming edge will be
  // live at any time. We stop at the first reachable Output in declaration
  // order.
  private reachableOutput():
    Extract<WorkflowNode, { kind: 'output' }> | undefined {
    for (const n of this.graph.nodes) {
      if (n.kind !== 'output') {
        continue
      }
      if (this.completed.has(n.id)) {
        continue
      }
      const inc = this.incoming.get(n.id) ?? []
      if (inc.some(this.isEdgeAlive)) {
        return n
      }
    }
    return undefined
  }

  // Resolve the node's "input" — for a single predecessor we pass that node's
  // output. For multi-predecessor we pass an object keyed by source node id so
  // downstream consumers can disambiguate.
  private resolveInput(nodeId: string): unknown {
    const inc = this.incoming.get(nodeId) ?? []
    const aliveIncoming = inc.filter(this.isEdgeAlive)
    // A `race` passes the WINNING upstream's output straight through as a single
    // value — its inputs all share one shape, so downstream sees that value, not
    // the multi-keyed object a normal multi-parent join produces. The winner is
    // the first alive incoming edge in declaration order (same deterministic,
    // replay-safe tie-break the Output node uses when branch arms converge).
    if (this.raceIds.has(nodeId)) {
      const winner = aliveIncoming[0]
      return winner ? this.nodeOutputs.get(winner.source) : undefined
    }
    // An `aggregate` collects EVERY live predecessor's output into an ordered
    // list — one element per producer, in edge-declaration order (`incoming` is
    // built in that order, and `filter` preserves it). Unlike the default join it
    // never keys by source id, so a downstream sibling can iterate the results
    // directly; unlike race it always waits for all producers (`every` readiness).
    // A single producer yields a one-element list, keeping the output a list in
    // every case.
    if (this.aggregateIds.has(nodeId)) {
      return aliveIncoming.map((e) => this.nodeOutputs.get(e.source))
    }
    return aliveIncoming.length === 1
      ? this.nodeOutputs.get(aliveIncoming[0].source)
      : Object.fromEntries(
          aliveIncoming.map((e) => [e.source, this.nodeOutputs.get(e.source)]),
        )
  }

  /**
   * Decide the next thing the backend should do. Returns an `execute`
   * instruction (run this node with this input), an `output` instruction
   * (terminal — finalize and return), or `stall` (malformed graph).
   *
   * Throws `WorkflowBudgetError` past the node budget. The trigger must be
   * seeded via `seedTrigger` before the first call.
   */
  next(): SchedulerInstruction {
    const out = this.reachableOutput()
    if (out) {
      const inc = this.incoming.get(out.id) ?? []
      const liveEdge = inc.find(this.isEdgeAlive)
      const output = liveEdge
        ? this.nodeOutputs.get(liveEdge.source)
        : undefined
      return { type: 'output', nodeId: out.id, output }
    }

    const next = this.graph.nodes.find((n) => this.isReady(n.id))
    if (!next) {
      return { type: 'stall' }
    }
    if (
      next.kind === 'trigger' ||
      next.kind === 'output' ||
      next.kind === 'note'
    ) {
      // Defensive — the bookends are handled outside the dispatch path, and a
      // portless Note never has live incoming edges to become ready.
      throw new Error(`Scheduler produced a ${next.kind} node as executable.`)
    }

    this.nodesFired += 1
    if (this.nodesFired > HARD_NODE_BUDGET) {
      throw new WorkflowBudgetError(HARD_NODE_BUDGET)
    }

    return { type: 'execute', node: next, input: this.resolveInput(next.id) }
  }

  /**
   * Like {@link next}, but returns EVERY ready node instead of the first, so a
   * backend can dispatch them concurrently. Output is checked first (matching
   * `next()`'s termination priority); otherwise the full ready-set is returned.
   * Because the ready-set is an antichain, the caller must `report()` every
   * returned node before calling `nextBatch()` again — the same barrier `next()`
   * relies on, which is why no in-flight bookkeeping is needed here.
   */
  nextBatch(): BatchInstruction {
    const out = this.reachableOutput()
    if (out) {
      const inc = this.incoming.get(out.id) ?? []
      const liveEdge = inc.find(this.isEdgeAlive)
      const output = liveEdge
        ? this.nodeOutputs.get(liveEdge.source)
        : undefined
      return { type: 'output', nodeId: out.id, output }
    }

    // `filter` preserves graph declaration order, so the batch — and any
    // sequence numbers a backend assigns from it — is deterministic across
    // replay. The bookend kinds never satisfy `isReady`, but we exclude them
    // explicitly so the result narrows to `ExecutableNode`.
    const ready = this.graph.nodes.filter(
      (n): n is ExecutableNode =>
        n.kind !== 'trigger' &&
        n.kind !== 'output' &&
        n.kind !== 'note' &&
        this.isReady(n.id),
    )
    if (ready.length === 0) {
      return { type: 'stall' }
    }

    this.nodesFired += ready.length
    if (this.nodesFired > HARD_NODE_BUDGET) {
      throw new WorkflowBudgetError(HARD_NODE_BUDGET)
    }

    return {
      type: 'execute',
      nodes: ready.map((node) => ({ node, input: this.resolveInput(node.id) })),
    }
  }

  /**
   * Record the result of an executed node. Decision nodes (branch/switch)
   * additionally pass a `branchResult` so outgoing-edge routing resolves; a
   * decision node's own output is its input passed straight through, decided by
   * the backend.
   */
  report(nodeId: string, result: ReportResult): void {
    this.nodeOutputs.set(nodeId, result.output)
    if (result.branchResult) {
      this.branchResults.set(nodeId, result.branchResult)
    }
    this.completed.add(nodeId)
  }
}
