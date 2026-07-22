import type { WorkflowStep } from 'cloudflare:workers'

import type { WfSdkConfig } from '../engine/config'
import type { WfRunManifestEntry } from '../engine/graph'
import type { RecordStepArgs } from '../engine/run-recorder'
import type { Scheduler } from '../engine/scheduler'
import type { StreamSink } from '../engine/stream-sink'

import type { GraphWorkflowEnv, GraphWorkflowParams } from './graph-workflow'
import type { RunRoom } from './run-room'

// Shared run-level locals every hoisted dispatch/log helper closes over. Bundled
// once in `run()` and threaded through so these functions can live at module
// scope instead of nested inside the ~500-line `run()` method.
export type RunCtx<TDeps, E extends GraphWorkflowEnv> = {
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
}
