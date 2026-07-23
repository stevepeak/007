import type { RunContext, WfSdkConfig } from './config'
import { isDecisionKind } from './graph'
import { errorMessage, runNode } from './run-node'
import { recordedBranchResult, type RunRecorder } from './run-recorder'
import {
  Scheduler,
  WorkflowStalledError,
  type ExecutableNode,
  type ReportResult,
} from './scheduler'
import type { StreamSink } from './stream-sink'
import { resolveTriggerInput } from './trigger-registry'

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
    try {
      const result = await runNode(
        { type: 'execute', node, input },
        {
          getModel: (modelId) => config.getModel(modelId, runContext),
          toolRegistry: config.toolRegistry,
          toolDeps,
          nodeOutputs: scheduler.getOutputs(),
          promptVariables: runContext.promptVariables,
          manifest: runContext.manifest,
          sink,
          resolveBlobRef: config.resolveBlobRef,
          resolveImageRef: config.resolveImageRef,
          simulate: runContext.simulate,
          fixtures: runContext.fixtures,
          freezeTools: runContext.freezeTools,
          agentOverride: runContext.agentOverride,
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
      })
      return {
        nodeId: node.id,
        report: {
          output: result.schedulerOutput,
          branchResult: result.branchResult,
        },
      }
    } catch (err) {
      await recorder.record({
        nodeId: node.id,
        nodeKind: node.kind,
        sequence: seq,
        input,
        status: 'failed',
        error: errorMessage(err),
      })
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
        await recorder.record({
          nodeId: instruction.nodeId,
          nodeKind: 'output',
          sequence: sequence++,
          input: instruction.output,
          status: 'completed',
          output: instruction.output,
        })
        const result = {
          output: instruction.output,
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
