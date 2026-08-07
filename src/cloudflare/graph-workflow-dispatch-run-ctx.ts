import type { WorkflowStep } from 'cloudflare:workers'

import type { RunDims } from '../analytics/points'
import type { TelemetrySink } from '../analytics/sink'
import type { WfSdkConfig } from '../engine/config'
import type { WfRunManifestEntry } from '../engine/graph'
import type { RecordStepArgs } from '../engine/run-recorder'
import type { Scheduler } from '../engine/scheduler'
import type { StreamSink } from '../engine/stream-sink'
import type { ModelPriceMap } from '../storage/cost'

import type { GraphWorkflowEnv, GraphWorkflowParams } from './graph-workflow'
import type { RunRoom } from './run-room'
import type { RunCounters } from './step-counter'

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
  p: GraphWorkflowParams
  manifest: WfRunManifestEntry[]
  sink: StreamSink
  recordOne: (args: RecordStepArgs) => Promise<void>
  room: DurableObjectStub<RunRoom>
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
