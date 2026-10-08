import { NonRetryableError } from 'cloudflare:workflows'

import {
  apiErrorDetail,
  errorFeedLine,
  errorStored,
} from '../engine/error-detail'
import { modelBudgetFor } from '../engine/model-budget'
import { nodeSpanLabel } from '../engine/node-label'
import { emitNodeStartProgress } from '../engine/node-progress'
import { isFatalAgentError } from '../engine/nodes/agent-generation'
import { runNode } from '../engine/run-node'
import type { ExecutableNode } from '../engine/scheduler'
import type { RunLogEntry, StreamSink } from '../engine/stream-sink'
import { createWfDb } from '../storage/client'

import type { GraphWorkflowEnv } from './graph-workflow'
import { nodeLabel } from './graph-workflow-dispatch-logs'
import {
  createNodeSink,
  runStepOrdinals,
} from './graph-workflow-dispatch-node-sink'
import type {
  CapturedFailure,
  RunCtx,
  RunStepResult,
} from './graph-workflow-dispatch-run-ctx'
import { spillNodeOutputs } from './graph-workflow-dispatch-spill'
import { stepDo } from './graph-workflow-dispatch-step'
import {
  resolveStepTimeoutMs,
  stepOptsFor,
} from './graph-workflow-dispatch-step-opts'
import { createTelemeteredRecorder } from './graph-workflow-telemetry'
import { runContextFor } from './run-context'
import { withNodeSpan } from './tracing'

// The ordinary node: one `run:` step, one `runNode` call inside it.
//
// This is the path every kind takes except the two that drive durable steps of
// their own (see `ownsItsDurableSteps`) — those get
// `graph-workflow-dispatch-iteration` and `-callee` instead, because `step.do`
// and `waitForEvent` cannot nest inside a `step.do`.

/** The node's configured step timeout, phrased for the run feed. */
export function describeStepTimeout(node: ExecutableNode): string {
  const ms = resolveStepTimeoutMs(node)
  const minutes = ms / 60_000
  return minutes >= 1
    ? `${Number(minutes.toFixed(1))} min`
    : `${Math.round(ms / 1000)}s`
}

// Run a node's body, capturing what went wrong while the real error object is
// still in hand and cutting the retry loop short when retrying is pointless.
//
// Three problems, all of which read to a user as "it hung":
//
//  1. Detail loss. Cloudflare RECONSTRUCTS an error thrown out of `step.do` —
//     the value the caller catches is a fresh Error carrying only a message and
//     stack. `APICallError`'s status code and provider response body (the part
//     that actually says *why*) never survive the crossing, so the outer catch
//     could only ever store a stack. Capturing here, inside the step, is the
//     only place that detail still exists.
//
//  2. Pointless retrying. `AI_STEP_OPTS` retries with exponential backoff,
//     which is right for a 429/503 and useless for "Payment Required" or a bad
//     model id — the same rejection just arrives minutes later. The AI SDK
//     already classifies this (`APICallError.isRetryable`), so a non-retryable
//     provider error is escalated to `NonRetryableError` and fails now.
//
//  3. Silence between attempts. A retryable failure is followed by a backoff
//     and another attempt; without a line here, that whole window is blank and
//     the node's closing `✕` line only ever reports the LAST attempt.
async function runNodeBody<T>(
  sink: StreamSink,
  onFailure: (captured: CapturedFailure) => void,
  body: () => Promise<T>,
): Promise<T> {
  try {
    return await body()
  } catch (err) {
    const feed = errorFeedLine(err)
    onFailure({ stored: errorStored(err), feed })
    const detail = apiErrorDetail(err)
    // A node that burned its ENTIRE budget — or ran its whole loop without
    // writing an answer — is not worth retrying: the retry repeats the same
    // work against the same wall, costing another full window of wall-clock to
    // reach the same non-answer. A single stalled round-trip or tool call is
    // the opposite — transient, and it falls through to the retry path below.
    if (isFatalAgentError(err)) {
      throw new NonRetryableError(feed)
    }
    if (detail?.isRetryable === false) {
      // Fatal: the node's closing `✕ … failed: <feed>` line already reports
      // this, so don't also log it inline — one failure, one line.
      throw new NonRetryableError(feed)
    }
    // Retryable: another attempt is coming and will overwrite the capture
    // above, so this line is the only trace this attempt ever happened.
    void sink.log?.({ level: 'warn', message: `${feed} — retrying` })
    throw err
  }
}

/**
 * Dispatch an ordinary node inside a single `run:` step.
 *
 * `bodyLogs` and `onFailure` write into locals the CALLER owns, hoisted out of
 * this closure on purpose. `step.do` replays the whole closure per attempt, and
 * both of them have to survive the closure THROWING: kept inside, a failed
 * node's trace died with it and the feed showed only "▶ node" … "✕ node failed",
 * with no sign of the ten tool calls it made first, and the outer catch had only
 * a stack to store. Each attempt resets them at the top — which is why
 * `onFailure` also takes `null`, for "this attempt has not failed yet" — so after
 * a throw they hold exactly the failed attempt's account.
 */
export async function dispatchPlain<TDeps, E extends GraphWorkflowEnv>(
  ctx: RunCtx<TDeps, E>,
  node: ExecutableNode,
  input: unknown,
  seq: number,
  bodyLogs: RunLogEntry[],
  onFailure: (captured: CapturedFailure | null) => void,
): Promise<RunStepResult> {
  const { step, env, config, p, manifest, scheduler, traceId } = ctx
  return await stepDo(step, `run:${node.id}`, stepOptsFor(node), async () => {
    const rc = runContextFor(p, env)
    const toolDeps = await config.buildRunDeps(rc)
    // Bound the node's model work from INSIDE the step, derived from the
    // very timeout Cloudflare would otherwise enforce from outside. The
    // in-process budget is strictly shorter, so it always wins the race —
    // turning a silent external kill into a caught, logged, attributable
    // failure.
    const modelBudget = modelBudgetFor(resolveStepTimeoutMs(node))
    // Every `step.do` ATTEMPT replays this closure from the top, so reset the
    // shared buffer and the capture here: a retry then rewrites the same
    // deterministic rows rather than appending a second copy of the node's feed.
    bodyLogs.length = 0
    onFailure(null)
    const { nextOrdinal, isRetry } = await runStepOrdinals(ctx, node)
    const nodeSink = createNodeSink(ctx, node, seq, bodyLogs, nextOrdinal)
    // A restart is the single most confusing thing a run can do: the node
    // silently begins again and repeats work already in the feed. Mark the
    // boundary explicitly, and name the most likely cause — the step timeout,
    // which kills the closure from OUTSIDE, so `runNodeBody`'s catch never runs
    // and no error line is ever emitted for it.
    if (isRetry) {
      void nodeSink.log?.({
        level: 'warn',
        message:
          `⟲ Restarting ${nodeLabel(node)} — the previous attempt ended without finishing ` +
          `(step timeout: ${describeStepTimeout(node)}). Everything above this line is from the abandoned attempt.`,
      })
    }
    // First-class user-facing line, first in the node's body feed (so the
    // terminal rewrite persists it): the author's progress note, if any.
    emitNodeStartProgress(nodeSink, node, p.runContext.promptVariables)
    // Bracket the real execution here — inside the run: step, right around
    // runNode — so the persisted Speed reflects actual work, not the durable-step
    // envelope. Journaled with the return value, so it replays deterministically.
    const execStartedAt = new Date()
    const r = await runNodeBody(nodeSink, onFailure, () => {
      return withNodeSpan(
        {
          traceId,
          runId: p.workflowRunId,
          nodeId: node.id,
          nodeKind: node.kind,
          sequence: seq,
          label: nodeSpanLabel(node, manifest),
          actorId: p.runContext.actorId,
          subjectId: p.runContext.subjectId,
          correlationId: p.runContext.correlationId,
        },
        () => {
          return runNode(
            { type: 'execute', node, input },
            {
              // Bridge the per-call reasoning intent through to the host.
              // Dropping `opts` here made `ModelFactory`'s contract a lie on the
              // production path — nothing passes an intent today (so this stays
              // undefined and the provider default wins), but a future caller
              // must not silently have it ignored. There is no run-level
              // reasoning on this path to fall back to: `start-run.ts` never
              // sets one.
              getModel: (modelId, opts) => {
                return config.getModel(modelId, {
                  ...rc,
                  reasoning: opts?.reasoning,
                })
              },
              getDecider: config.getDecider
                ? (modelId) => config.getDecider!(modelId, rc)
                : undefined,
              toolRegistry: config.toolRegistry,
              referenceKinds: config.referenceKinds ?? [],
              toolDeps,
              modelBudget,
              nodeOutputs: scheduler.getOutputs(),
              promptVariables: p.runContext.promptVariables,
              manifest,
              sink: nodeSink,
              resolveBlobRef: config.resolveBlobRef,
              simulate: p.runContext.simulate,
              fixtures: p.runContext.fixtures,
              liveReads: p.runContext.liveReads,
              toolModes: p.runContext.toolModes,
              freezeTools: p.runContext.freezeTools,
              agentOverride: p.runContext.agentOverride,
              // Delegation: an agent node may spawn sub-agents/workflows inline
              // and record each as a child step. Built inside this `run:` closure
              // (a D1 binding can't cross a step boundary); the whole closure
              // replays on retry and the `(run_id, node_id, item_index)` upsert
              // makes that idempotent.
              subStepRecorder:
                node.kind === 'agent'
                  ? createTelemeteredRecorder({
                      db: createWfDb(env.WF_DB),
                      runId: p.workflowRunId,
                      telemetry: ctx.telemetry,
                      dims: ctx.dims,
                      prices: ctx.prices,
                      logger: ctx.logger,
                    })
                  : undefined,
            },
          )
        },
      )
    })
    // Last thing before the value crosses the durable boundary: anything too big
    // to journal is written out and replaced by a pointer. Inside the closure on
    // purpose — out here the payload would already have had to survive the
    // crossing we're protecting.
    const outputs = await spillNodeOutputs(
      config,
      toolDeps,
      { runId: p.workflowRunId, nodeId: node.id, slot: 'node-output' },
      r,
    )
    return {
      ...r,
      ...outputs,
      logs: bodyLogs,
      execStartedAt,
      execFinishedAt: new Date(),
    }
  })
}
