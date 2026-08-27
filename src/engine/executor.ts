import type { RunContext, WfSdkConfig } from './config'
import { isDecisionKind } from './graph'
import { resolveAnswerNodeIds } from './graph-engine'
import type { ModelBudget } from './model-budget'
import { emitNodeStartProgress } from './node-progress'
import { settleOf, type NodeSettlement } from './node-settlement'
import type { ChildWorkflowRunner } from './nodes/workflow'
import { endEntryOf, startEntryOf } from './run-log-entries'
import { errorMessage, runNode } from './run-node'
import { recordedBranchResult, type RunRecorder } from './run-recorder'
import {
  Scheduler,
  WorkflowStalledError,
  type ExecutableNode,
  type ReportResult,
} from './scheduler'
import type { RunLogEntry, StreamSink } from './stream-sink'
import { enforceOutputContract, resolveTriggerInput } from './trigger-registry'

export type ExecuteWorkflowDeps<TDeps> = {
  /** Raw graph JSON from a workflow_version row. Validated here. */
  graph: unknown
  /** Validated against the matching trigger entry before any node fires. */
  triggerInput: unknown
  /** The host-injection contract — model factory, tools, deps, triggers. */
  config: WfSdkConfig<TDeps>
  /** Per-run context passed to `buildRunDeps` + prompt interpolation. */
  runContext: RunContext
  /** Recorder writes one run-step row per node. */
  recorder: RunRecorder
  /** Optional live progress sink. */
  sink?: StreamSink
  /**
   * What bounds a node's model work, per node. Optional because the original
   * callers (evals, tests, the playground) block a process they own and can
   * just wait.
   *
   * The INLINE engine must supply one. It runs unattended inside a Durable
   * Object with no `step.do` timeout behind it, so this is the only thing that
   * can cut a wedged provider call short — without it a stalled request hangs
   * the run silently and forever, which is exactly the invisible-stall failure
   * the budget was built to eliminate on the durable path.
   */
  resolveModelBudget?: (node: ExecutableNode) => ModelBudget | undefined
  /**
   * Called the moment the run's answer is final — BEFORE the walk drains the
   * arms that don't feed it. This is what lets a backend mark the run `done`
   * and release whoever is waiting on the answer, while the leftover work keeps
   * running behind it (see {@link WorkflowOutputDelivery}).
   *
   * Awaited, and allowed to throw: a backend that cannot persist the answer has
   * produced nothing the host can read, so the failure belongs to the run.
   */
  onOutput?: (delivery: WorkflowOutputDelivery) => void | Promise<void>
  /**
   * This run was SPAWNED by another run — it is a workflow-call node's callee,
   * not something a host started. Two boundary checks are then skipped, exactly
   * as they are on the durable backend (see `GraphWorkflowParams.subRun`): the
   * trigger input is seeded raw, and the Output value skips the trigger's
   * output contract. Both belong to the seam between a HOST and a run; the
   * caller has already built the value, and a callee answers to its caller,
   * not to its trigger's contract.
   */
  spawned?: boolean
  /**
   * How this backend starts a workflow-call node's callee as its own child run.
   * Threaded straight onto the node context — see
   * `RunNodeContext.runChildWorkflow`. Omitted by callers that can't spawn a
   * run (tests, the playground), which run the callee inline as a subgraph.
   */
  runChildWorkflow?: ChildWorkflowRunner
}

/**
 * The run's answer, handed over the instant it is settled.
 *
 * `pendingWork` is the `done` vs `completed` signal: true when arms remain to
 * execute after this Output, so the backend should mark the run `done` now and
 * `completed` when {@link executeWorkflow} resolves. False means the walk is
 * already finished and the backend can settle it in one write.
 */
export type WorkflowOutputDelivery = {
  output: unknown
  /** The Output node that produced it, or null on a fizzled decision arm. */
  outputNodeId: string | null
  pendingWork: boolean
  /**
   * How many nodes are executing RIGHT NOW, behind the answer. Zero with
   * `pendingWork: true` means work is ready but not yet started. Backends
   * surface it on the run's `done` lifecycle marker, so the activity feed says
   * what the run is still doing rather than just that it isn't finished.
   */
  pendingNodes: number
}

/**
 * The delta channel one node should be given — the safety rule behind
 * {@link StreamSink.delta}, named so it can be tested on its own rather than
 * inferred from a run.
 *
 * Two conditions, both required:
 *   • the run's sink can stream at all (the inline backend's can; the durable
 *     backend's cannot, and so defines no `delta`), and
 *   • this node is one the Output binds to, i.e. it produces the answer.
 *
 * Anything else gets `undefined`, which is what tells a node handler not to
 * stream. Getting this wrong in the permissive direction is the failure that
 * matters: an intermediate agent's working notes rendered to the reader as if
 * they were the answer.
 */
export function deltaChannelFor(
  sink: StreamSink,
  answerNodeIds: ReadonlySet<string>,
  nodeId: string,
): StreamSink['delta'] {
  if (!sink.delta || !answerNodeIds.has(nodeId)) return undefined
  return (text: string) => sink.delta?.(text)
}

export type ExecuteWorkflowResult = {
  output: unknown
  /** The Output node that produced `output`, or `null` when the run ended on a
   * decision arm that fizzled out (no Output was reached). */
  outputNodeId: string | null
  /**
   * A failure from the DRAIN phase — a background arm that broke after the
   * answer was already delivered. Never fails the run: the answer stood, and
   * the caller was released before this node ever ran. Recorded so the run row
   * says a background arm broke rather than pretending the run was clean; the
   * node's own failed step row carries the detail.
   */
  drainError?: string
}

/**
 * In-process backend: walks a graph via the pure {@link Scheduler}, awaiting
 * each node inline (no durability). The Cloudflare `GraphWorkflow` drives the
 * same Scheduler + {@link runNode} but wraps each node in `step.do`. This one
 * powers the eval harness, the tests, and the inline engine.
 *
 * Two-phase by design. Reaching an Output makes the run `done` — the answer is
 * final and {@link ExecuteWorkflowDeps.onOutput} fires immediately so a waiting
 * reader is released. The walk then keeps going until every remaining arm is
 * exhausted, and only then resolves: the run is `completed`. Arms that don't
 * feed the Output (a `branch → tool` side effect, say) run in that drain phase,
 * behind the answer rather than instead of it.
 *
 * The walk is ROLLING, not batched: it starts every newly-ready node and then
 * waits for the FIRST of them to settle, re-checking for a reachable Output on
 * each one. The batched form it replaced could only see the Output at a
 * barrier, so a slow background node sharing a fan-out with the answer arm
 * added its whole duration to what the caller waited for — the exact case
 * `done` exists to avoid.
 */
export async function executeWorkflow<TDeps>(
  deps: ExecuteWorkflowDeps<TDeps>,
): Promise<ExecuteWorkflowResult> {
  const { config, runContext, recorder, sink } = deps
  const scheduler = new Scheduler(deps.graph, config.limits?.nodeBudget)
  const trigger = scheduler.trigger

  // Per-node sink wrapper. A node handler emits entries knowing only what it
  // has to say, not where it sits in the walk, so stamp identity on the way
  // out — mirroring the durable backend's `nodeSink`.
  //
  // Without this every agent-emitted line (reasoning, tool calls) arrives with
  // no `nodeId`, and a sink that persists per node drops the lot: the run then
  // shows a node that opened and never said another word, which reads as a hung
  // run even when the agent is working perfectly.
  // The nodes whose output the Output node(s) bind to — see
  // `resolveAnswerNodeIds`. Resolved once, up front, so the delta channel can be
  // handed to exactly the node that writes the answer.
  const answerNodeIds = resolveAnswerNodeIds(deps.graph)

  const sinkFor = (node: ExecutableNode, seq: number): StreamSink | undefined =>
    sink && {
      log: (entry: RunLogEntry) =>
        sink.log?.({
          ...entry,
          ts: entry.ts ?? Date.now(),
          nodeId: entry.nodeId ?? node.id,
          nodeKind: entry.nodeKind ?? node.kind,
          sequence: entry.sequence ?? seq,
        }),
      // Handed ONLY to the answer-producing node, and only when the backend can
      // carry a stream at all — see `deltaChannelFor`.
      delta: deltaChannelFor(sink, answerNodeIds, node.id),
    }

  const validatedTriggerInput = deps.spawned
    ? deps.triggerInput
    : resolveTriggerInput(
        config.triggers,
        trigger.config.triggerKind,
        deps.triggerInput,
      )

  const toolDeps = await config.buildRunDeps(runContext)

  let sequence = 0

  // Record the trigger as a step + seed its output. The trigger "executes"
  // instantly — its output is the validated triggerInput.
  await recorder.record({
    nodeId: trigger.id,
    nodeKind: 'trigger',
    sequence: sequence++,
    input: validatedTriggerInput,
    status: 'completed',
    output: validatedTriggerInput,
  })
  scheduler.seedTrigger(validatedTriggerInput)

  // Execute one node inline, record its outcome, and return what the scheduler
  // needs. A failed node records its failed step and rethrows. Mirrors the
  // Cloudflare backend's `dispatchNode` (there each node drives durable steps;
  // here it's a plain await) so both backends fan out a ready-set identically.
  const dispatchNode = async (
    node: ExecutableNode,
    input: unknown,
    seq: number,
  ): Promise<{ nodeId: string; report: ReportResult }> => {
    // Bracket the real execution — runs inline here, so wall-clock is exact.
    const startedAt = new Date()
    const nodeSink = sinkFor(node, seq)
    // Mark the node RUNNING before it runs, exactly as the durable backend's
    // `enter:` step does. Two consumers need it: the run viewer's active-node
    // highlight reads `running` step rows, and a node that never settles leaves
    // a row saying which one it was. Recording only on completion (as this
    // backend used to) means an in-flight node has no row at all — the run looks
    // like it stopped after the previous node.
    //
    // The recorder upserts on `(run_id, node_id, item_index)`, so the terminal
    // record below overwrites this row rather than adding one.
    await recorder.record({
      nodeId: node.id,
      nodeKind: node.kind,
      sequence: seq,
      input,
      status: 'running',
      startedAt,
    })
    // Open the node's feed. The durable backend emits this from its `enter:`
    // step; here there is no step to hang it off, but the entry matters just as
    // much — the run viewer derives the *currently active* node from a
    // `node-start` with no matching `node-end`, so a backend that skipped it
    // would render as a run where nothing is happening.
    await nodeSink?.log?.(startEntryOf(node, seq, startedAt.getTime()))
    // First-class user-facing line: the node's author-provided progress note,
    // if any. Emitted at the top-level dispatch so inner subgraph nodes (which
    // run through `runNode` directly) stay quiet in the user feed.
    emitNodeStartProgress(nodeSink, node, runContext.promptVariables)
    try {
      const result = await runNode(
        { type: 'execute', node, input },
        {
          getModel: (modelId, opts) =>
            config.getModel(modelId, {
              ...runContext,
              reasoning: opts?.reasoning ?? runContext.reasoning,
            }),
          toolRegistry: config.toolRegistry,
          toolDeps,
          nodeOutputs: scheduler.getOutputs(),
          promptVariables: runContext.promptVariables,
          manifest: runContext.manifest,
          sink: nodeSink,
          resolveBlobRef: config.resolveBlobRef,

          simulate: runContext.simulate,
          fixtures: runContext.fixtures,
          liveReads: runContext.liveReads,
          freezeTools: runContext.freezeTools,
          agentOverride: runContext.agentOverride,
          // Supplied by callers that run unattended — the inline engine derives
          // it from the node's declared timeout, the same number the durable
          // backend gives `step.do`. Absent for evals/tests/the playground,
          // which block a process they own and can simply wait.
          modelBudget: deps.resolveModelBudget?.(node),
          // An iteration node records its inner subgraph steps (once per item)
          // through the same recorder that persists top-level steps.
          subStepRecorder: recorder,
          // Threaded through unchanged, so a workflow node nested in an
          // iteration item spawns its callee exactly like a top-level one.
          runChildWorkflow: deps.runChildWorkflow,
        },
      )
      await recorder.record({
        nodeId: node.id,
        nodeKind: node.kind,
        sequence: seq,
        input,
        status: 'completed',
        output: result.recordedOutput,
        meta: result.meta,
        branchResult: recordedBranchResult(result),
        startedAt,
        finishedAt: new Date(),
      })
      await nodeSink?.log?.(endEntryOf(node, seq, Date.now(), false))
      return {
        nodeId: node.id,
        report: {
          output: result.schedulerOutput,
          branchResult: result.branchResult,
        },
      }
    } catch (err) {
      const message = errorMessage(err)
      await recorder.record({
        nodeId: node.id,
        nodeKind: node.kind,
        sequence: seq,
        input,
        status: 'failed',
        error: message,
        startedAt,
        finishedAt: new Date(),
      })
      await nodeSink?.log?.(endEntryOf(node, seq, Date.now(), true, message))
      // Best-effort node: continue the run with a `null` output rather than
      // aborting. Mirrors the Cloudflare backend; never for decision nodes.
      if (node.execution?.continueOnError && !isDecisionKind(node.kind)) {
        return { nodeId: node.id, report: { output: null } }
      }
      throw err
    }
  }

  // Lifecycle callbacks mirror the Cloudflare backend: best-effort host
  // notifications that never change the run outcome (a throwing callback is
  // swallowed and logged). No durable step here — the in-process backend awaits
  // inline — but the contract the host sees is identical.
  const notifyHost = async (fn: () => void | Promise<void>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      console.error('[wf] lifecycle callback failed:', errorMessage(err))
    }
  }

  // The answer, once settled. Its presence is what turns the loop below from
  // "producing the answer" into "draining what's left": every exit and failure
  // path reads differently on each side of it.
  let delivered: ExecuteWorkflowResult | null = null

  // First failure from the drain phase, if any. Kept out of `delivered` so the
  // answer and the fault stay separable right up to the return.
  let drainError: string | undefined

  // Hand the answer over and release whoever is waiting on it. Runs BEFORE the
  // drain, so a background arm can never delay a reader — the whole point of
  // the `done` state.
  const deliver = async (
    output: unknown,
    outputNodeId: string | null,
  ): Promise<ExecuteWorkflowResult> => {
    // `hasPendingWork`, not `hasReadyWork`: the background arms are RUNNING at
    // this point, not merely ready, and reporting nothing pending here would
    // settle the run `completed` while its side effects were still executing.
    await deps.onOutput?.({
      output,
      outputNodeId,
      pendingWork: scheduler.hasPendingWork(),
      pendingNodes: scheduler.inFlightCount(),
    })
    if (config.onRunComplete) {
      await notifyHost(() =>
        config.onRunComplete!(runContext, { output, outputNodeId }),
      )
    }
    return { output, outputNodeId }
  }

  // Nodes started but not yet settled, keyed by node id so the winner of the
  // race below can be removed. Each promise is written never to reject — see
  // `settleOf` — because a rejecting entry would tear down the whole race and
  // lose the identity of which node broke.
  const inflight = new Map<string, Promise<NodeSettlement>>()

  // A node broke: stop starting NEW work but keep awaiting what is already
  // running, since an in-flight node cannot be cancelled.
  let stopDispatch = false

  // Wait for every outstanding node without caring how any of them ends. Used
  // on the failure paths, where the run's outcome is already decided but the
  // in-flight work still has to land before we return.
  const drainInflight = async (): Promise<void> => {
    await Promise.allSettled(inflight.values())
    inflight.clear()
  }

  try {
    while (true) {
      // 1. The answer, the instant it becomes reachable. Polled on every settle
      //    rather than at a batch barrier — this is what keeps a slow
      //    background arm from delaying the caller.
      const out = scheduler.pollOutput()
      if (out) {
        // The bound Output value must satisfy the trigger's output contract
        // (e.g. a chat run must produce `{ text }`); this throws — failing the
        // run via the surrounding catch — rather than letting the host read an
        // empty result. Contract-less triggers pass through untouched.
        // Only the FIRST Output answers to the contract: it is the one the host
        // reads. A later arm reaching its own Output is recorded for the trace
        // but changes nothing the caller already received.
        // A spawned callee skips it too: it answers to the node that called it,
        // and the inline path it stands in for enforced nothing.
        const output =
          delivered || deps.spawned
            ? out.output
            : enforceOutputContract(
                config.triggers,
                trigger.config.triggerKind,
                out.output,
              )
        await recorder.record({
          nodeId: out.nodeId,
          nodeKind: 'output',
          sequence: sequence++,
          input: out.output,
          status: 'completed',
          output,
        })
        // Mark it settled so the walk moves past it to the arms that don't feed
        // it, rather than being handed the same Output on every call.
        scheduler.completeOutput(out.nodeId, output)
        if (!delivered) {
          delivered = await deliver(output, out.nodeId)
        }
        continue
      }

      // 2. Start everything that has become ready, answer-critical nodes first.
      //    Sequence numbers are assigned at dispatch, so the trace reads in
      //    execution order.
      if (!stopDispatch) {
        for (const item of scheduler.takeReady()) {
          const seq = sequence++
          inflight.set(
            item.node.id,
            settleOf(item.node.id, dispatchNode(item.node, item.input, seq)),
          )
        }
      }

      // 3. Nothing ready and nothing running.
      if (inflight.size === 0) {
        // Past the answer this is simply the end of the walk: every arm has run
        // itself out and the run is `completed`, not merely `done`.
        if (delivered) {
          break
        }
        // A decision node whose taken arm has no outgoing edge ends that path
        // quietly — an intentional "fizzle out", not a malformed graph. Finish
        // with no output. A stall with no decision ever fired is a genuinely
        // unreachable Output, which stays an error.
        if (!scheduler.hasRoutedDecision()) {
          throw new WorkflowStalledError()
        }
        delivered = await deliver(undefined, null)
        break
      }

      // 4. Wait for the FIRST node to settle, then loop — so the Output check
      //    above runs again as soon as anything at all has changed.
      const settled = await Promise.race(inflight.values())
      inflight.delete(settled.nodeId)

      if (!settled.ok) {
        // The node is out of flight but never completed, so its arm stays dead
        // and it is never re-selected.
        scheduler.abandon(settled.nodeId)
        // Before the answer, a failed node fails the run — but only after the
        // work already running has landed, since it cannot be cancelled. After
        // the answer, what the host received cannot be retracted, so the broken
        // arm is reported alongside the result and the drain stops starting new
        // work while its siblings finish.
        if (!delivered) {
          await drainInflight()
          throw settled.error
        }
        drainError ??= errorMessage(settled.error)
        stopDispatch = true
        continue
      }

      scheduler.report(settled.nodeId, settled.report)
    }

    return drainError ? { ...delivered, drainError } : delivered
  } catch (err) {
    // Same rule as a rejected drain node, applied to everything else the drain
    // can throw (the node budget, a recorder write, a second Output's step):
    // once the answer is out, the run is not a failure. Report it as a drain
    // error and let the backend settle the run with the answer it already gave.
    if (delivered) {
      await drainInflight()
      return {
        ...(delivered),
        drainError: drainError ?? errorMessage(err),
      }
    }
    await drainInflight()
    if (config.onRunFailed) {
      await notifyHost(() =>
        config.onRunFailed!(runContext, { error: errorMessage(err) }),
      )
    }
    throw err
  }
}
