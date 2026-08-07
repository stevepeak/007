import type { AnalyticsEngineDataset } from '@cloudflare/workers-types'

import type { TelemetrySink } from '../analytics/sink'

// The Analytics Engine implementation of `TelemetrySink`. `AnalyticsEngineDataset`
// is a TYPE-ONLY import, so this module is erased at build and stays reachable
// from the import-safe `./cloudflare` barrel — unlike `tracing.ts`, which is
// `/runtime`-only because it value-imports `@sentry/cloudflare`.

/**
 * AE accepts 250 data points per Worker invocation. A wide iteration (20 items
 * × a 10-node subgraph at `concurrency: 20`) can approach that inside a single
 * wake, so the sink stops short of the ceiling and counts what it refused
 * rather than letting AE reject writes invisibly.
 */
export const MAX_POINTS_PER_INVOCATION = 200

export type CreateAnalyticsEngineTelemetryOptions = {
  /**
   * A THUNK, not the binding. Live bindings cannot cross a `step.do` boundary,
   * and a Workflow's `run()` re-executes from the top on every wake with a
   * fresh `this.env` — resolving late means the closure is always current.
   * Returning undefined (binding absent) makes the sink inert.
   */
  dataset: () => AnalyticsEngineDataset | undefined
  maxPoints?: number
}

export function createAnalyticsEngineTelemetry(
  opts: CreateAnalyticsEngineTelemetryOptions,
): TelemetrySink {
  const max = opts.maxPoints ?? MAX_POINTS_PER_INVOCATION
  let written = 0
  let dropped = 0
  return {
    write(point) {
      if (written >= max) {
        dropped++
        return
      }
      const ds = opts.dataset()
      if (!ds) return
      // Telemetry must never fail a run: `writeDataPoint` is fire-and-forget,
      // but a missing binding or a malformed point would otherwise throw
      // straight out of the recorder and fail the step that called it.
      try {
        ds.writeDataPoint(point)
        written++
      } catch (err) {
        dropped++
        console.error('[wf] analytics writeDataPoint failed', err)
      }
    },
    dropped() {
      return dropped
    },
  }
}
