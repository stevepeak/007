import { NonRetryableError } from 'cloudflare:workflows'

import type { WorkflowCallNode } from '../engine/graph'
import { resolveCallee } from '../engine/nodes/workflow'
import { errorMessage } from '../engine/run-node'
import { createWfDb } from '../storage/client'

import {
  InvalidEventTypeError,
  calleeEventType,
  unwrapCalleeWire,
} from './callee-protocol'
import type { CalleeDoneEvent, CalleeDoneWire } from './callee-protocol'
import { reportCalleeResult, spawnCalleeRun } from './child-run'
import type { GraphWorkflowEnv } from './graph-workflow'
import type {
  RunCtx,
  RunStepResult,
} from './graph-workflow-dispatch-run-ctx'
import { stepDo } from './graph-workflow-dispatch-step'
import {
  DEFAULT_STEP_OPTS,
  resolveStepTimeoutMs,
} from './graph-workflow-dispatch-step-opts'

// ── Called workflows ────────────────────────────────────────────────────────
//
// A workflow-call node runs its callee as a CHILD RUN — never inlined into this
// node's step. The callee gets its own `wf_run` (linked back to this run and
// this node), and executes on the engine ITS OWN trigger declares; see
// `spawnCalleeRun` for why the caller has no say in that.
//
// The handshake is spawn → park → event, not spawn → poll: an instance parked on
// `waitForEvent` is hibernated and does NOT count against the concurrency cap,
// so a parent waiting on a long callee costs nothing. Polling would burn a step
// per check and keep the parent resident.

/**
 * Tell whoever spawned this run that it settled. No-op for a top-level run.
 *
 * Runs in its own durable step: the parent is parked indefinitely (up to the
 * node's timeout) and this is the only thing that will ever wake it, so it has
 * to survive the same retries every other write does.
 */
export async function reportToParent<TDeps, E extends GraphWorkflowEnv>(
  ctx: RunCtx<TDeps, E>,
  payload: CalleeDoneEvent,
): Promise<void> {
  const sub = ctx.p.subRun
  if (!sub) {
    return
  }
  await stepDo(ctx.step, 'report-to-parent', DEFAULT_STEP_OPTS, async () => {
    try {
      await reportCalleeResult(ctx.env, sub, payload)
    } catch (err) {
      // An invalid event type is rejected by the platform and retried on the
      // standard backoff for hours, while the parent shows only a generic
      // timeout — so a malformed handshake fails here, where the cause has a
      // name, and retrying it can never help.
      if (err instanceof InvalidEventTypeError) {
        throw new NonRetryableError(errorMessage(err))
      }
      throw err
    }
    return null
  })
}

/**
 * Run a workflow-call node by spawning its callee as a child run and parking
 * until it reports back.
 *
 * Like `dispatchIteration` this is NOT wrapped in a `run:` step — `step.do` and
 * `waitForEvent` can't nest inside another step, and the whole point is for the
 * callee's nodes to own steps of their own.
 */
export async function dispatchCallee<TDeps, E extends GraphWorkflowEnv>(
  ctx: RunCtx<TDeps, E>,
  node: WorkflowCallNode,
  input: unknown,
): Promise<RunStepResult> {
  const { step, env, p, manifest, scheduler, instanceId, traceId } = ctx
  let callee: ReturnType<typeof resolveCallee>
  try {
    callee = resolveCallee({
      node,
      input,
      nodeOutputs: scheduler.getOutputs(),
      manifest,
    })
  } catch (err) {
    // A callee missing from the frozen manifest stays missing on every retry.
    throw new NonRetryableError(errorMessage(err))
  }
  const { entry, triggerInput } = callee
  const eventType = calleeEventType(node.id)

  // Create the callee's own `wf_run` and start it in ONE journaled step, so a
  // replay reuses both rather than minting a second run and a second instance.
  const spawned = await stepDo(
    step,
    `spawn:${node.id}`,
    DEFAULT_STEP_OPTS,
    async () => {
      return await spawnCalleeRun(env, createWfDb(env.WF_DB), {
        entry,
        triggers: ctx.config.triggers,
        triggerInput,
        parentRunId: p.workflowRunId,
        nodeId: node.id,
        runContext: p.runContext,
        manifest,
        // Same trace as the parent, so the callee's spans land in one
        // distributed trace instead of a detached second one.
        traceId,
        parent: { kind: 'instance', instanceId },
        eventType,
      })
    },
  )

  // Park. The timeout is the node's own declared step timeout, so the author's
  // one knob still bounds the callee — and a child that dies without ever
  // reporting surfaces as a legible timeout instead of a permanently stuck run.
  const settled = await step.waitForEvent<CalleeDoneWire>(`await:${node.id}`, {
    type: eventType,
    timeout: resolveStepTimeoutMs(node),
  })

  const output = unwrapCalleeWire({
    wire: settled.payload,
    failed: `Called workflow "${entry.name}" failed`,
    toError: (message) => new NonRetryableError(message),
  })
  return {
    schedulerOutput: output,
    recordedOutput: output,
    // The link the run viewer needs to offer a drill-down into the callee's own
    // trace, and which engine that trace will be shaped like.
    meta: {
      ...callee.meta,
      childRunId: spawned.childRunId,
      engine: spawned.engine,
    },
  }
}
