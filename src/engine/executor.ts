import type { RunContext, WfSdkConfig } from './config'
import { isDecisionKind } from './graph'
import { resolveAnswerNodeIds } from './graph-engine'
import type { ModelBudget } from './model-budget'
import { emitNodeStartProgress } from './node-progress'
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
}

/**
 * In-process backend: walks a graph via the pure {@link Scheduler}, awaiting
 * each node inline (no durability). The Cloudflare `GraphWorkflow` drives the
 * same Scheduler + {@link runNode} but wraps each node in `step.do`. This one
 * powers the eval harness and tests.
 */
export async function executeWorkflow<TDeps>(
  deps: ExecuteWorkflowDeps<TDeps>,
): Promise<ExecuteWorkflowResult> {
  const { config, runContext, recorder, sink } = deps
  const scheduler = new Scheduler(deps.graph)
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
      append: (channel, text) => sink.append(channel, text),
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

  const validatedTriggerInput = resolveTriggerInput(
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
          resolveImageRef: config.resolveImageRef,
          simulate: runContext.simulate,
          fixtures: runContext.fixtures,
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

  try {
    while (true) {
      const instruction = scheduler.nextBatch()

      if (instruction.type === 'stall') {
        // A decision node whose taken arm has no outgoing edge ends that path
        // quietly — an intentional "fizzle out", not a malformed graph. Finish
        // with no output. A stall with no decision ever fired is a genuinely
        // unreachable Output, which stays an error.
        if (!scheduler.hasRoutedDecision()) {
          throw new WorkflowStalledError()
        }
        const result = { output: undefined, outputNodeId: null }
        if (config.onRunComplete) {
          await notifyHost(() => config.onRunComplete!(runContext, result))
        }
        return result
      }

      if (instruction.type === 'output') {
        // The bound Output value must satisfy the trigger's output contract
        // (e.g. a chat run must produce `{ text }`); this throws — failing the
        // run via the surrounding catch — rather than letting the host read an
        // empty result. Contract-less triggers pass through untouched.
        const output = enforceOutputContract(
          config.triggers,
          trigger.config.triggerKind,
          instruction.output,
        )
        await recorder.record({
          nodeId: instruction.nodeId,
          nodeKind: 'output',
          sequence: sequence++,
          input: instruction.output,
          status: 'completed',
          output,
        })
        const result = {
          output,
          outputNodeId: instruction.nodeId,
        }
        if (config.onRunComplete) {
          await notifyHost(() => config.onRunComplete!(runContext, result))
        }
        return result
      }

      // Sequences assigned up front in stable batch order → deterministic trace
      // regardless of settle order. Batch nodes are independent (antichain), so
      // they run concurrently.
      const batch = instruction.nodes.map((n) => ({
        node: n.node,
        input: n.input,
        seq: sequence++,
      }))

      const settled = await Promise.allSettled(
        batch.map((b) => dispatchNode(b.node, b.input, b.seq)),
      )

      const rejected = settled.find((s) => s.status === 'rejected')
      if (rejected && rejected.status === 'rejected') {
        throw rejected.reason
      }

      for (const s of settled) {
        if (s.status === 'fulfilled') {
          scheduler.report(s.value.nodeId, s.value.report)
        }
      }
    }
  } catch (err) {
    if (config.onRunFailed) {
      await notifyHost(() =>
        config.onRunFailed!(runContext, { error: errorMessage(err) }),
      )
    }
    throw err
  }
}
