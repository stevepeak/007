import type { WorkflowStep } from 'cloudflare:workers'

import type { RunDims } from '../analytics/points'
import type { WfSdkConfig } from '../engine/config'
import type { ModelPriceMap } from '../engine/cost'
import type { WfRunManifestEntry } from '../engine/graph'
import type { WfLogger } from '../engine/logger'
import type { NodeRunResult } from '../engine/run-node'
import type { RecordStepArgs } from '../engine/run-recorder'
import type { Scheduler } from '../engine/scheduler'
import type { RunLogEntry, StreamSink } from '../engine/stream-sink'
import type { TelemetrySink } from '../engine/telemetry'

import type { GraphWorkflowEnv, GraphWorkflowParams } from './graph-workflow'
import type { RunCounters } from './step-counter'

// The types every hoisted dispatch helper shares: the run-level locals they close
// over, the shape a dispatched node hands back, and what a failed attempt
// managed to learn on its way out.
//
// They live in their own module because the dispatch is now five of them —
// `dispatchNode` orchestrates, and `-plain`, `-iteration` and `-callee` each own
// one dispatch shape — and none of those should have to import another just to
// name its own return type.

// Shared run-level locals every hoisted dispatch/log helper closes over. Bundled
// once in `run()` and threaded through so these functions can live at module
// scope instead of nested inside the ~500-line `run()` method.
export type RunCtx<TDeps, E extends GraphWorkflowEnv> = {
  /**
   * Already wrapped by {@link createCountingStep} — every helper that reaches
   * for a step goes through `ctx.step`, so wrapping once here is what makes the
   * step tally complete without touching a single call site.
   */
  step: WorkflowStep
  env: E
  config: WfSdkConfig<TDeps>
  /**
   * Where this run's swallowed faults go — `config.logger` already resolved
   * (and guarded), so the dispatch helpers report without each re-deriving it.
   * The console when the host wired none.
   */
  logger: WfLogger
  p: GraphWorkflowParams
  manifest: WfRunManifestEntry[]
  sink: StreamSink
  recordOne: (args: RecordStepArgs) => Promise<void>
  scheduler: Scheduler
  traceId: string | undefined
  /**
   * This instance's own id (`event.instanceId`). Handed to a spawned child so it
   * can `sendEvent` back to the parent that is parked waiting for it.
   */
  instanceId: string
  /**
   * Run-scoped tallies (billable steps, nodes, iteration items, failures) — read
   * in the run's last step and reported as telemetry. Mutated in place; the
   * orchestrator replays deterministically, so the totals do too.
   */
  counters: RunCounters
  /** Where telemetry points go. The no-op sink when no host wired one. */
  telemetry: TelemetrySink
  /** Run-scoped dimensions stamped on every point. */
  dims: RunDims
  /**
   * The model catalog's prices, frozen at run start (see the `load-graph` step),
   * so a step's dollar cost is stamped with what it cost WHEN IT RAN rather than
   * re-derived against whatever the catalog says later.
   */
  prices: ModelPriceMap
  /**
   * When the run began, epoch ms, from the journaled `begin-run` step. Null for
   * an instance that resumed across the deploy that added it.
   */
  runStartedAtMs: number | null
}

// What a dispatched node hands back: the engine's NodeRunResult plus the
// structured log entries the node emitted during its own step (captured by a
// per-node sink), so they survive `step.do` replay via the workflow journal.
// `execStartedAt`/`execFinishedAt` bracket the actual `runNode` call (measured
// inside the run: step, so they're journaled) — this is the true execution
// window the Speed stat reads, as opposed to the wider dispatch envelope that
// spans the enter:/run:/record: durable-step boundaries. A self-stepping node
// (iteration, workflow call) has no `run:` step, so it leaves all three unset.
export type RunStepResult = NodeRunResult & {
  logs?: RunLogEntry[]
  execStartedAt?: Date
  execFinishedAt?: Date
}

/** What a failed attempt knew about its error, captured before the error
 * crosses the `step.do` boundary (see `runNodeBody`). */
export type CapturedFailure = { stored: string; feed: string }
