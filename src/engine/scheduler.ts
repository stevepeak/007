import { NodeOutputs, resolveBinding } from './binding'
import {
  isBookendKind,
  workflowGraphSchema,
  type BookendNodeKind,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
} from './graph'
import { buildAdjacency } from './graph-adjacency'
import { answerCriticalIds } from './graph-answer-cone'

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
  { kind: BookendNodeKind }
>

/** A node the backend must execute, with its resolved input. */
export type ExecuteInstruction = {
  type: 'execute'
  node: ExecutableNode
  input: unknown
}

/**
 * One executable node + its resolved input, as claimed by
 * {@link Scheduler.takeReady}.
 *
 * A claim is an antichain: an ordinary work node is ready only once ALL its
 * predecessors are `completed`, so no two claimed nodes have an edge between
 * them and they run safely in parallel. A `race` node is the one exception —
 * it's ready on its FIRST completed predecessor, so it can be claimed while
 * another of its predecessors is still running. That is harmless: its input is
 * resolved from already-completed edges only, and the in-flight bookkeeping
 * makes it fire exactly once, so the not-yet-done predecessor's result is
 * simply ignored.
 */
export type BatchItem = { node: ExecutableNode; input: unknown }

/**
 * The run has reached an Output node — its answer is final.
 *
 * NOT the end of the walk. An Output settles what the CALLER receives; it says
 * nothing about the other arms of the graph, which may still have unrun nodes
 * (a fire-and-forget tool hanging off a branch that never feeds the Output).
 * A backend must therefore call {@link Scheduler.completeOutput} and keep
 * pulling instructions until `stall` — see the `done` vs `completed` split in
 * the run lifecycle. Returning here is what silently dropped those arms.
 */
export type OutputInstruction = {
  type: 'output'
  nodeId: string
  output: unknown
}

/**
 * No node is ready and no Output is reachable. What that means depends on
 * whether the backend has already delivered an answer: after an Output it is
 * the ordinary end of the walk (every arm exhausted, the run is `completed`);
 * before one it's either a decision arm that fizzled out or — with no decision
 * ever routed — a malformed graph.
 */
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
// Workflows runtime ceiling. 256 is well above any realistic graph. A host that
// genuinely needs a bigger fan-out can raise it via `WfSdkConfig.limits.nodeBudget`
// (threaded into the Scheduler constructor); this is the default.
export const DEFAULT_NODE_BUDGET = 256

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

  private readonly incoming: Map<string, WorkflowEdge[]>
  // Ids of `race` nodes — the first-to-finish join. They flip readiness from the
  // default all-predecessors (`every`) rule to any-predecessor (`some`), so we
  // only need the id set, not the full node map.
  private readonly raceIds = new Set<string>()
  // Ids of `aggregate` nodes — the wait-for-all fan-in join. They keep the
  // default `every` readiness (unlike race) but shape their resolved input into
  // an ordered list rather than the default single-value / keyed-object form.
  private readonly aggregateIds = new Set<string>()

  private readonly completed = new Set<string>()
  // Nodes handed to a backend by `takeReady` and not yet `report`ed. Under the
  // old barrier walk this was unnecessary — the caller reported every node
  // before asking again — but rolling dispatch asks for more work while nodes
  // are still running, so readiness has to exclude what is already out.
  private readonly inFlight = new Set<string>()
  // Nodes whose execution failed. Neither completed (their outgoing edges must
  // stay dead) nor selectable again — see `abandon`.
  private readonly failed = new Set<string>()
  // Nodes that can influence some Output's value. Derived once from the graph
  // (see `answerCriticalIds`); drives dispatch order only, never readiness.
  private readonly answerCritical: Set<string>
  private readonly branchResults = new Map<string, string>()
  // Seeded with the graph's node identities so a failed ref names the boxes the
  // author drew rather than their uuids. Assigned in the constructor — it needs
  // the parsed graph.
  private readonly nodeOutputs: NodeOutputs
  private nodesFired = 0
  // The runaway-loop backstop for THIS run (host-tunable; defaults to
  // DEFAULT_NODE_BUDGET). Nested subgraph schedulers get their own budget.
  private readonly nodeBudget: number

  constructor(rawGraph: unknown, nodeBudget: number = DEFAULT_NODE_BUDGET) {
    this.nodeBudget = nodeBudget
    this.graph = workflowGraphSchema.parse(rawGraph)
    const trigger = this.graph.nodes.find((n) => n.kind === 'trigger')
    if (!trigger) {
      // Already caught by superRefine, but the type narrowing needs this.
      throw new Error('Graph has no trigger node.')
    }
    this.trigger = trigger
    this.nodeOutputs = new NodeOutputs(this.graph.nodes)
    for (const n of this.graph.nodes) {
      if (n.kind === 'race') {
        this.raceIds.add(n.id)
      }
      if (n.kind === 'aggregate') {
        this.aggregateIds.add(n.id)
      }
    }
    this.incoming = buildAdjacency(this.graph).incoming
    this.answerCritical = answerCriticalIds(this.graph)
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
   * A {@link NodeOutputs} rather than a bare Map — it also carries the graph's
   * node labels, so binding errors raised anywhere downstream can name nodes.
   */
  getOutputs(): NodeOutputs {
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

  /**
   * Settle an Output node the backend has just handled: record its value and
   * mark it completed so `next()`/`pollOutput()` move PAST it to whatever else
   * is still ready, instead of handing back the same Output forever.
   *
   * This is the hinge of the `done` / `completed` split. The run is `done` the
   * moment an Output is reached — the answer is final and the caller can be
   * released — but it is `completed` only once every remaining arm has run
   * itself out. Backends used to `return` on the Output instruction, which
   * killed sibling arms mid-flight: a `branch → tool` arm hanging off the
   * trigger would route, become ready, and then never fire because the answer
   * arm won the race to the Output.
   */
  completeOutput(nodeId: string, value: unknown): void {
    this.nodeOutputs.set(nodeId, value)
    this.completed.add(nodeId)
  }

  /**
   * Whether any executable node is ready RIGHT NOW — i.e. could be started on
   * the next `takeReady`. Excludes nodes already in flight; see
   * {@link hasPendingWork} for the question a backend actually wants answered.
   */
  hasReadyWork(): boolean {
    return this.graph.nodes.some(
      (n) => !isBookendKind(n) && this.isReady(n.id),
    )
  }

  /**
   * Whether ANY work remains — a node still running, or one ready to start.
   * This is the `done` vs `completed` predicate: a backend asks it the moment
   * an Output settles, to tell "answer delivered, background arms still going"
   * from "answer delivered, nothing left" (the latter settles in one write).
   *
   * The in-flight half is not optional. Under rolling dispatch the background
   * arms are *running*, not merely ready, at the instant the Output surfaces —
   * asking only `hasReadyWork()` there would report nothing pending and mark
   * the run `completed` while its side effects were still executing.
   */
  hasPendingWork(): boolean {
    return this.inFlight.size > 0 || this.hasReadyWork()
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
    if (
      this.completed.has(nodeId) ||
      this.inFlight.has(nodeId) ||
      this.failed.has(nodeId)
    ) {
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

  // An Output is reachable once one of its incoming edges is live. The edge only
  // gates WHEN it fires — the VALUE it returns is named separately by its
  // `source` ref (see `resolveOutputValue`). Multiple Output nodes are legal (one
  // per branch arm); a single Output with multiple incoming edges (branch arms
  // converging) also works — exactly one incoming edge will be live at any time.
  // We stop at the first reachable Output in declaration order.
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

  // Resolve the VALUE an Output returns to the caller. The value is named
  // explicitly by the Output's `source` ref, resolved against the run's global
  // node-output map — the same mechanism agent/tool/branch/iteration inputs use.
  // This makes "what the caller receives" an explicit, typed choice rather than
  // "whatever node happened to be on the live edge". An Output with no `source`
  // is a malformed graph (the author never bound a value), so we throw loudly
  // rather than silently return `undefined` — the strict runtime gate and the
  // author-time diagnostics both flag this before a run reaches here.
  private resolveOutputValue(
    out: Extract<WorkflowNode, { kind: 'output' }>,
  ): unknown {
    const { source } = out.config
    if (!source) {
      throw new Error(
        `${this.nodeOutputs.describe(out.id)} has no bound value — connect its source to the upstream result the caller should receive.`,
      )
    }
    return resolveBinding(source, this.nodeOutputs, {
      nodeId: out.id,
      name: 'output',
    })
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
   * (the answer is final — deliver it, call `completeOutput`, keep walking),
   * or `stall` (nothing left; see {@link StallInstruction}).
   *
   * Throws `WorkflowBudgetError` past the node budget. The trigger must be
   * seeded via `seedTrigger` before the first call.
   */
  next(): SchedulerInstruction {
    const out = this.reachableOutput()
    if (out) {
      return { type: 'output', nodeId: out.id, output: this.resolveOutputValue(out) }
    }

    const next = this.graph.nodes.find((n) => this.isReady(n.id))
    if (!next) {
      return { type: 'stall' }
    }
    if (isBookendKind(next)) {
      // Defensive — the bookends are handled outside the dispatch path, and a
      // portless Note never has live incoming edges to become ready.
      throw new Error(`Scheduler produced a ${next.kind} node as executable.`)
    }

    this.nodesFired += 1
    if (this.nodesFired > this.nodeBudget) {
      throw new WorkflowBudgetError(this.nodeBudget)
    }

    return { type: 'execute', node: next, input: this.resolveInput(next.id) }
  }

  /**
   * The reachable Output, if there is one, so a backend can ask at ANY moment
   * rather than only when a whole ready-set has settled.
   *
   * That distinction is the whole point. Under the barrier walk the Output was
   * not even *observable* until every node dispatched alongside the answer arm
   * had settled, so a slow background node hung off the same fan-out added its
   * full duration to what the caller waited for. Polled per settle, the answer
   * is released the moment its own arm reports.
   */
  pollOutput(): OutputInstruction | undefined {
    const out = this.reachableOutput()
    if (!out) return undefined
    return {
      type: 'output',
      nodeId: out.id,
      output: this.resolveOutputValue(out),
    }
  }

  /**
   * Claim every currently-ready node for execution, answer-critical nodes
   * first, and mark them in flight so a later call cannot hand back the same
   * node twice. Returns `[]` when nothing is ready — which, combined with
   * "nothing in flight", is the caller's stall condition.
   *
   * There is NO barrier: a backend may call it
   * again while earlier nodes are still running, and gets only what has become
   * ready since. The `inFlight` bookkeeping is what makes that safe, and it is
   * also what now guarantees a `race` node fires exactly once — under the
   * barrier that fell out of "a completed node is never re-selected", which no
   * longer holds while the race's own execution is outstanding.
   *
   * Ordering is answer-critical first, then graph declaration order within each
   * group (`filter` preserves it), keeping dispatch deterministic across a
   * durable replay. The ordering is a preference, never a gate: background
   * nodes go out in the same call, so nothing is deferred behind the answer.
   */
  takeReady(): BatchItem[] {
    const ready = this.graph.nodes.filter(
      (n): n is ExecutableNode => !isBookendKind(n) && this.isReady(n.id),
    )
    if (ready.length === 0) return []

    this.nodesFired += ready.length
    if (this.nodesFired > this.nodeBudget) {
      throw new WorkflowBudgetError(this.nodeBudget)
    }

    const ordered = [
      ...ready.filter((n) => this.answerCritical.has(n.id)),
      ...ready.filter((n) => !this.answerCritical.has(n.id)),
    ]
    // Resolve inputs BEFORE marking anything in flight: `resolveInput` reads
    // only `completed` state, but keeping the two phases apart means a future
    // change to either can't quietly make a node's input depend on whether a
    // sibling in the same call was claimed first.
    const items = ordered.map((node) => ({
      node,
      input: this.resolveInput(node.id),
    }))
    for (const item of items) this.inFlight.add(item.node.id)
    return items
  }

  /** How many nodes are dispatched but not yet reported. */
  inFlightCount(): number {
    return this.inFlight.size
  }

  /**
   * Release a node claimed by {@link takeReady} WITHOUT completing it — for a
   * node whose execution failed.
   *
   * Deliberately not `completed`: an edge is alive only from a completed
   * source, so this arm stays dead and nothing downstream of it becomes ready
   * (the node produced no output for them to consume). But it must leave
   * `inFlight`, or `hasPendingWork` would report work forever, and it must not
   * fall back into the ready set, or the next `takeReady` would re-dispatch it.
   * The `failed` set is what holds that middle position.
   */
  abandon(nodeId: string): void {
    this.inFlight.delete(nodeId)
    this.failed.add(nodeId)
  }

  /**
   * Record the result of an executed node. Decision nodes (branch/switch)
   * additionally pass a `branchResult` so outgoing-edge routing resolves; their
   * recorded `output` is the decision itself (`{ result, reasoning }`) — nodes
   * don't forward their input, so downstream reaches pre-decision data by ref.
   */
  report(nodeId: string, result: ReportResult): void {
    this.inFlight.delete(nodeId)
    this.nodeOutputs.set(nodeId, result.output)
    if (result.branchResult) {
      this.branchResults.set(nodeId, result.branchResult)
    }
    this.completed.add(nodeId)
  }
}
