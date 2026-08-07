import type { RunRecorder } from '../engine/run-recorder'
import type { ModelPriceMap } from '../storage/cost'

import { encodeStepPoint, type RunDims } from './points'
import { safeWrite, type TelemetrySink } from './sink'

// Step telemetry rides on the recorder rather than on the dispatch path,
// because the recorder is the only seam EVERY step passes through. Three of the
// four durable recorder construction sites are nested — the iteration
// sub-recorder and the sub-agent recorder record steps that top-level
// `recordTerminal` never sees, and those are exactly the agent steps carrying
// the most tokens. Decorating the recorder instruments all of them at once.

/**
 * Wrap a recorder so every TERMINAL step also emits a data point. The `running`
 * record is skipped: it opens a row that the terminal record overwrites, and
 * emitting both would double every step in AE.
 *
 * The inner recorder is awaited FIRST — D1 is the source of truth, and a point
 * for a step that failed to persist would be a step no one can look up.
 */
export function withStepTelemetry(
  recorder: RunRecorder,
  sink: TelemetrySink,
  dims: RunDims,
  prices?: ModelPriceMap,
): RunRecorder {
  return {
    async record(args) {
      await recorder.record(args)
      if (args.status === 'running') return
      safeWrite(
        sink,
        encodeStepPoint(
          dims,
          {
            nodeId: args.nodeId,
            nodeKind: args.nodeKind,
            status: args.status,
            sequence: args.sequence,
            itemIndex: args.itemIndex,
            parentNodeId: args.parentNodeId,
            startedAt: args.startedAt,
            finishedAt: args.finishedAt,
            meta: args.meta,
            error: args.error,
          },
          prices,
        ),
      )
    },
  }
}
