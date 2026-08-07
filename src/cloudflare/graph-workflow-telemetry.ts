import { encodeRunPoint, type RunDims } from '../analytics/points'
import { withStepTelemetry } from '../analytics/recorder'
import {
  NOOP_TELEMETRY,
  safeWrite,
  type TelemetrySink,
} from '../analytics/sink'
import type { WfSdkConfig } from '../engine/config'
import type { RunRecorder } from '../engine/run-recorder'
import type { WfDb } from '../storage/client'
import type { ModelPriceMap } from '../storage/cost'
import { createDurableRunRecorder } from '../storage/run-recorder'

import type { GraphRunContextInput, GraphWorkflowEnv } from './graph-workflow'
import type { RunCtx } from './graph-workflow-dispatch-run-ctx'
import type { RunCounters } from './step-counter'

// Assembling telemetry for a run: resolving the host's sink, building the
// dimension bundle every point carries, and the one recorder factory all four
// construction sites go through.

/**
 * The host's sink for this invocation, or the no-op. Resolved ONCE per wake — a
 * Workflow's `run()` re-executes from the top on every wake, which is exactly
 * the scope the sink's per-invocation point cap wants.
 *
 * A host hook that throws must not take the run with it: telemetry is additive,
 * and a run that died because its analytics binding misbehaved would be a
 * strictly worse outcome than a run with no analytics.
 */
export function resolveTelemetrySink<TDeps>(
  config: WfSdkConfig<TDeps>,
  env: unknown,
): TelemetrySink {
  if (!config.resolveTelemetry) return NOOP_TELEMETRY
  try {
    return config.resolveTelemetry({ env }) ?? NOOP_TELEMETRY
  } catch (err) {
    console.error('[wf] resolveTelemetry failed; telemetry disabled', err)
    return NOOP_TELEMETRY
  }
}

/**
 * The run-scoped dimensions every point carries. `workflowId` comes from the
 * `load-graph` step (the version row already knows it); it is '' for an instance
 * resuming on new code with an older journal entry, and {@link RunDims} covers
 * that by indexing on the version id instead.
 */
export function runDims(args: {
  workflowId: string
  workflowVersionId: string
  runId: string
  runContext: GraphRunContextInput
}): RunDims {
  return {
    workflowId: args.workflowId,
    workflowVersionId: args.workflowVersionId,
    runId: args.runId,
    triggerKind: args.runContext.triggerKind,
    traceId: args.runContext.traceId,
    isEval: args.runContext.isEval,
    simulate: args.runContext.simulate,
  }
}

/**
 * A durable recorder that also emits step telemetry — the ONLY way this SDK
 * builds a recorder on the durable path. Bundling the two is the point: three
 * of the four construction sites are nested inside step closures (iteration
 * items, spawned sub-agents), and those carry the bulk of a run's tokens, so a
 * site that quietly built a bare recorder would silently under-report spend.
 */
export function createTelemeteredRecorder(deps: {
  db: WfDb
  runId: string
  telemetry: TelemetrySink
  dims: RunDims
  prices?: ModelPriceMap
}): RunRecorder {
  return withStepTelemetry(
    createDurableRunRecorder({ db: deps.db, runId: deps.runId }),
    deps.telemetry,
    deps.dims,
    deps.prices,
  )
}

/**
 * Tally a run's shape from the steps it records — nodes, failures, and iteration
 * items — for a backend that has no orchestrator to count in.
 *
 * INLINE ONLY. The durable backend must accumulate these in its orchestrator
 * instead: a `step.do` replay re-runs the record and would inflate a counter
 * kept out here, while the orchestrator's own counters re-derive to the same
 * value on every wake. Nothing replays inline, so counting at the recorder is
 * both correct and the only place these numbers exist.
 */
export function withRunCounts(
  recorder: RunRecorder,
  counters: RunCounters,
): RunRecorder {
  return {
    async record(args) {
      await recorder.record(args)
      // Terminal records only — a node opens with `running` and closes with its
      // outcome, and counting both would double every node.
      if (args.status === 'running') return
      if (args.status === 'failed') counters.failedNodes++
      // Iteration inner steps carry a real item index; they belong to their
      // container, not to the top-level node count.
      if ((args.itemIndex ?? -1) >= 0) return
      if (args.nodeKind !== 'trigger' && args.nodeKind !== 'output') {
        counters.nodes++
      }
      if (args.nodeKind === 'iteration') {
        const total = (args.meta as { total?: unknown } | undefined)?.total
        if (typeof total === 'number') counters.iterationItems += total
      }
    },
  }
}

/**
 * Emit the run's single terminal point. MUST be called from inside the run's
 * last durable step — the orchestrator body re-executes on every wake, so an
 * emission out there would fire once per hibernation.
 *
 * `extraSteps` covers the steps that are still to come but whose existence is
 * already decided: on the failure path `record-failure` is followed by
 * `report-to-parent` (only for a spawned callee) and `on-failed` (only when the
 * host wired the callback), both known booleans at this point. On the success
 * path nothing follows `settle`, so it is 0.
 *
 * Token and dollar totals are deliberately absent — readers SUM them from the
 * step points sharing this run id, which is the only accounting that includes
 * iteration items and spawned sub-agents.
 */
export function emitRunPoint<TDeps, E extends GraphWorkflowEnv>(
  ctx: RunCtx<TDeps, E>,
  args: {
    status: 'completed' | 'failed'
    outputNodeId?: string | null
    error?: string
    extraSteps: number
  },
): void {
  const finishedAtMs = Date.now()
  safeWrite(
    ctx.telemetry,
    encodeRunPoint(ctx.dims, {
      status: args.status,
      engine: 'durable',
      outputNodeId: args.outputNodeId,
      error: args.error,
      // Null only for an instance resuming across the deploy that added the
      // journaled start instant; latency then reads 0 rather than nonsense.
      startedAtMs: ctx.runStartedAtMs ?? finishedAtMs,
      finishedAtMs,
      nodeCount: ctx.counters.nodes,
      iterationItems: ctx.counters.iterationItems,
      workflowSteps: ctx.counters.steps + args.extraSteps,
      failedNodeCount: ctx.counters.failedNodes,
      droppedPoints: ctx.telemetry.dropped(),
    }),
  )
}
