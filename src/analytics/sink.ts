import type { TelemetryPoint } from './points'

// The telemetry seam, deliberately shaped like `RunRecorder`: the engine hands
// points to an interface and an implementation decides where they land. The SDK
// never names a Cloudflare binding on this path — the Analytics Engine sink
// lives in `../cloudflare/analytics-engine.ts` and the host injects it — so the
// in-process engine (evals, tests, the playground) runs with the no-op default.
//
// `write` is SYNCHRONOUS and must never throw. `writeDataPoint` is itself
// fire-and-forget, and telemetry that could fail a run — or make the recorder
// await a second I/O hop per step — would be worse than no telemetry.

export interface TelemetrySink {
  write(point: TelemetryPoint): void
  /**
   * Points refused so far by the per-invocation cap. Reported on the run point
   * (`double8`) so loss is visible in the data instead of silent.
   */
  dropped(): number
}

/** The default when no host wires telemetry. Costs one dead call per step. */
export const NOOP_TELEMETRY: TelemetrySink = {
  write() {},
  dropped() {
    return 0
  },
}

/**
 * Emit a point without letting telemetry take a run down with it.
 *
 * The contract says `write` never throws, but the sink is HOST-supplied — this
 * is the one place that enforces it, so a misbehaving implementation costs a
 * data point instead of the step that was merely describing itself.
 */
export function safeWrite(sink: TelemetrySink, point: TelemetryPoint): void {
  try {
    sink.write(point)
  } catch (err) {
    console.error('[wf] telemetry sink threw; point dropped', err)
  }
}

/**
 * Captures points in memory for tests — the telemetry counterpart to
 * `createMemoryRunRecorder`. Uncapped on purpose: a test asserting the cap
 * should construct the capped sink explicitly rather than inherit a limit.
 */
export function createMemoryTelemetrySink(): TelemetrySink & {
  points: TelemetryPoint[]
} {
  const points: TelemetryPoint[] = []
  return {
    points,
    write(point) {
      points.push(point)
    },
    dropped() {
      return 0
    },
  }
}
