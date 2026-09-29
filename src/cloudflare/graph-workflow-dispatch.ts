import { NonRetryableError } from 'cloudflare:workflows'

import { errorFeedLine, errorStored } from '../engine/error-detail'
import { isDecisionKind } from '../engine/graph'
import { emitNodeStartProgress } from '../engine/node-progress'
import { recordedBranchResult } from '../engine/run-recorder'
import type { ExecutableNode, ReportResult } from '../engine/scheduler'
import type { RunLogEntry } from '../engine/stream-sink'
import { enforceOutputContract } from '../engine/trigger-registry'
import { createWfDb } from '../storage/client'
import { completeRun, markRunDone } from '../storage/data'

import type { GraphWorkflowEnv, GraphWorkflowResult } from './graph-workflow'
import { dispatchCallee, reportToParent } from './graph-workflow-dispatch-callee'
import { dispatchIteration } from './graph-workflow-dispatch-iteration'
import { enterStep, recordTerminal } from './graph-workflow-dispatch-logs'
import {
  createNodeSink,
  selfSteppingOrdinals,
} from './graph-workflow-dispatch-node-sink'
import { dispatchPlain } from './graph-workflow-dispatch-plain'
import type {
  CapturedFailure,
  RunCtx,
  RunStepResult,
} from './graph-workflow-dispatch-run-ctx'
import { rehydrateAtBoundary } from './graph-workflow-dispatch-spill'
import { notifyHost, stepDo } from './graph-workflow-dispatch-step'
import { emitRunPoint } from './graph-workflow-telemetry'
import { runContextFor } from './run-context'

// The dispatch envelope: `dispatchNode` opens and settles one node's durable
// steps, and `deliverOutput` / `settleRun` close out the run. The three node
// SHAPES each own a module of their own (`-plain`, `-iteration`, `-callee`), as
// do the pieces they all share: the log bookends and the terminal rewrite
// (`-logs`), the live per-node feed writer (`-node-sink`), the R2 spill
// boundaries (`-spill`), the step wrapper (`-step`) and its options
// (`-step-opts`).

// Re-export the extracted helpers so every symbol that historically lived in
// this module stays importable from `./graph-workflow-dispatch`.
export {
  AI_STEP_OPTS,
  DEFAULT_STEP_OPTS,
} from './graph-workflow-dispatch-step-opts'
export { notifyHost, stepDo } from './graph-workflow-dispatch-step'
export { reportToParent } from './graph-workflow-dispatch-callee'
export type { RunCtx } from './graph-workflow-dispatch-run-ctx'

// Execute one node: enter, dispatch by shape, settle. Three SEPARATE durable
// steps (`enter:` / `run:` / `record:`), because fusing run and record means a
// failed *record* write re-runs the entire body on retry — `step.do` retries
// replay the whole closure — so a transient DB hiccup would re-invoke the model
// and any side-effecting tools. Split, the record step retries on its own while
// the node's (already-successful) result replays from the workflow journal.
//
// The three dispatch shapes live in their own modules and share only this
// envelope: `dispatchPlain` (one `run:` step, the common case),
// `dispatchIteration` and `dispatchCallee` (no `run:` step at all — they drive
// durable steps of their own, which cannot nest inside one).
//
// A failed node records its own failed step (so it can't re-run the body) and
// rethrows, unless it is best-effort.
export async function dispatchNode<TDeps, E extends GraphWorkflowEnv>(
  ctx: RunCtx<TDeps, E>,
  node: ExecutableNode,
  input: unknown,
  seq: number,
): Promise<{ nodeId: string; report: ReportResult }> {
  const { startEntry } = await enterStep(ctx, node, seq, input)

  // Both hoisted OUT of the dispatch below so they survive it THROWING —
  // `bodyLogs` holds whatever the failed attempt managed to emit (without it a
  // failed node's whole trace is discarded), `captured` holds its error detail,
  // taken inside the step where the real error object still exists. See
  // `dispatchPlain`, which resets both per attempt.
  const bodyLogs: RunLogEntry[] = []
  let captured: CapturedFailure | null = null

  let result: RunStepResult
  try {
    if (node.kind === 'iteration') {
      // No progress emit here: an iteration's note needs the item count, which
      // only exists once the list is resolved inside `runIteration` — that's
      // where both its note and its per-item lines are emitted.
      result = await dispatchIteration(
        ctx,
        node,
        createNodeSink(ctx, node, seq, bodyLogs, selfSteppingOrdinals(bodyLogs)),
      )
    } else if (node.kind === 'workflow') {
      // Same reason as iteration: this node drives durable steps of its own
      // (spawn + waitForEvent), which can't live inside a `run:` step.
      const nodeSink = createNodeSink(
        ctx,
        node,
        seq,
        bodyLogs,
        selfSteppingOrdinals(bodyLogs),
      )
      emitNodeStartProgress(nodeSink, node, ctx.p.runContext.promptVariables)
      result = await dispatchCallee(ctx, node, input)
    } else {
      result = await dispatchPlain(ctx, node, input, seq, bodyLogs, (c) => {
        captured = c
      })
    }
  } catch (err) {
    // Prefer what the attempt captured on its way out: `err` here has been
    // rebuilt by the workflow runtime and is a stack with no provider detail.
    const failure: CapturedFailure = captured ?? {
      stored: errorStored(err),
      feed: errorFeedLine(err),
    }
    ctx.counters.failedNodes++
    await recordTerminal(ctx, node, seq, input, startEntry, {
      status: 'failed',
      error: failure.stored,
      feed: failure.feed,
      bodyLogs,
    })
    // Best-effort node: swallow the failure and let the run continue with a
    // `null` output (downstream refs resolve to null). Never for decision
    // nodes — a routing decision has no safe default, so it must still
    // abort. The failed step above keeps the failure visible in the trace.
    if (node.execution?.continueOnError && !isDecisionKind(node.kind)) {
      return { nodeId: node.id, report: { output: null } }
    }
    throw err
  }

  await recordTerminal(ctx, node, seq, input, startEntry, {
    status: 'completed',
    output: result.recordedOutput,
    meta: result.meta,
    branchResult: recordedBranchResult(result),
    // `logs` is the `run:` step's journaled copy — the same array, returned
    // through the step so it survives replay. A self-stepping node has no such
    // step and fills `bodyLogs` directly.
    bodyLogs: result.logs ?? bodyLogs,
    startedAt: result.execStartedAt,
    finishedAt: result.execFinishedAt,
  })

  return {
    nodeId: node.id,
    report: {
      output: result.schedulerOutput,
      branchResult: result.branchResult,
    },
  }
}

// Deliver a run's answer: persist the output, wake a waiting parent, and
// best-effort notify the host. Shared by the two success
// exits — a reached Output (with its node id) and a decision that fizzled
// out (output `undefined`, no node id).
//
// This makes the run `done`, NOT `completed`. Arms that don't feed the Output
// keep executing behind it and `settleRun` closes the run out when they finish;
// `pendingWork` is what tells the two apart, and under the rolling walk it must
// count nodes that are RUNNING as well as ready (see `Scheduler.hasPendingWork`)
// — the background arms are mid-flight at this exact moment. Everyone waiting on
// an answer — the host callback, a parent workflow parked on a callee — is
// released here rather than behind a background arm they never depended on.
export async function deliverOutput<TDeps, E extends GraphWorkflowEnv>(
  ctx: RunCtx<TDeps, E>,
  rawOutput: unknown,
  outputNodeId: string | null,
  pendingWork: boolean,
): Promise<GraphWorkflowResult> {
  const { step, env, config, p, scheduler } = ctx
  // Enforce the trigger's output contract (e.g. chat's `{ text }`) before we
  // persist anything: a run whose Output was bound to the wrong shape — or that
  // fizzled out with no result under a contract that requires one — fails here
  // (the caller's catch records the failure) rather than the host reading an
  // empty result. Contract-less triggers pass through.
  // A spawned callee skips the contract for the same reason it skips trigger
  // validation: it answers to the node that called it, not to its own trigger,
  // and being called must not change whether a workflow is allowed to finish.
  // The PARENT's own Output still answers to its own trigger's contract.
  //
  // A large answer arrives here as a blob pointer (see
  // `graph-workflow-dispatch-spill`), and the contract is a Zod check that
  // would reject the pointer's shape, so both the check and the write need the
  // value read back. That read is R2 I/O, which cannot happen out here: this
  // body re-executes on every wake, and a non-deterministic call in it would
  // re-run once per hibernation. So `answerFor` does the read INSIDE whichever
  // step needs it — and the pointer, not the payload, is what this function
  // returns, since the instance result has a size cap of its own and `wf_run`
  // is where the host reads the answer from anyway.
  const answerFor = async (): Promise<unknown> => {
    const answer = p.subRun
      ? rawOutput
      : await rehydrateAtBoundary(
          config,
          () => {
            return config.buildRunDeps({
              ...p.runContext,
              env,
              runId: p.workflowRunId,
            })
          },
          rawOutput,
        )
    if (p.subRun) return answer
    try {
      return enforceOutputContract(
        config.triggers,
        scheduler.trigger.config.triggerKind,
        answer,
      )
    } catch (err) {
      // The contract cannot come out true on a retry — the graph is bound the
      // way it is bound. Retrying would spend the node's whole backoff
      // schedule re-deriving the same rejection, so fail now and let the
      // caller's catch record it, exactly as it did when this check ran in the
      // orchestrator body.
      throw new NonRetryableError(
        err instanceof Error ? err.message : String(err),
      )
    }
  }
  await stepDo(step, 'finalize', async () => {
    return await markRunDone(createWfDb(env.WF_DB), {
      runId: p.workflowRunId,
      output: await answerFor(),
      settled: !pendingWork,
      pendingNodes: scheduler.inFlightCount(),
    })
  })
  // The callee reports its pointer as-is: the parent hands it to a node that
  // rehydrates inside its own step, so the payload never touches the 1 MiB
  // event cap. `rawOutput` is already contract-free for a sub-run.
  await reportToParent(ctx, { ok: true, output: rawOutput })
  if (config.onRunComplete) {
    await notifyHost(
      step,
      'on-complete',
      async () => {
        return await config.onRunComplete!(runContextFor(p, env), {
          output: await answerFor(),
          outputNodeId,
        })
      },
      ctx.logger,
    )
  }
  return { output: rawOutput, outputNodeId }
}

/**
 * Close out a run whose every arm has finished. A no-op-ish second write that
 * only matters when {@link deliverOutput} left the run `done` because there was
 * still work to drain.
 *
 * `drainError` is an arm that broke AFTER the answer went out. It never fails
 * the run — the host already has a correct answer — so it lands on the run row
 * as a note beside the failed node's own step, and the result the caller gets
 * back is the one it was already promised.
 */
export async function settleRun<TDeps, E extends GraphWorkflowEnv>(
  ctx: RunCtx<TDeps, E>,
  result: GraphWorkflowResult,
  drainError?: string,
): Promise<GraphWorkflowResult> {
  const { step, env, p } = ctx
  await stepDo(step, 'settle', async () => {
    await completeRun(createWfDb(env.WF_DB), {
      runId: p.workflowRunId,
      error: drainError,
    })
    // Emitted from INSIDE the last step, never from the orchestrator body — the
    // body re-executes on every wake, so an emission there would fire once per
    // hibernation. `settle` is genuinely last on the success path (finalize,
    // report-to-parent and on-complete all precede it), so the step tally read
    // here is the run's final count.
    emitRunPoint(ctx, {
      status: 'completed',
      outputNodeId: result.outputNodeId,
      error: drainError,
      extraSteps: 0,
    })
  })
  if (drainError) {
    ctx.logger.warn(
      `[wf] run ${p.workflowRunId} delivered its output, but a background branch failed`,
      drainError,
    )
  }
  return result
}
