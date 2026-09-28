// Run telemetry: the Analytics Engine column layout and encoders, the recorder
// decorator that emits a point per terminal step, and the dashboard's read
// queries. Everything here is runtime-neutral — the Cloudflare Analytics Engine
// implementation lives in `../cloudflare/analytics-engine.ts`.
//
// The SINK SEAM itself (`TelemetrySink`, `NOOP_TELEMETRY`, `safeWrite`) lives in
// `../engine/telemetry.ts`, because `WfSdkConfig.resolveTelemetry` declares it
// and `engine` may not import upward (ART-189). It is re-exported below so
// `@stevepeak/007/analytics` keeps the same surface it always had.
export {
  encodeRunPoint,
  encodeStepPoint,
  TELEMETRY_SCHEMA_VERSION,
  type RunDims,
  type RunPointInput,
  type StepPointInput,
  type TelemetryPoint,
} from './points'
export {
  analyticsCoversWindow,
  loadRunVolume,
  loadSpend,
  loadWorkflowSteps,
  ANALYTICS_MAX_WINDOW_SEC,
  type AnalyticsCostRow,
  type AnalyticsStepsRow,
  type AnalyticsVolumeRow,
} from './dashboard'
export {
  assertDatasetName,
  createAnalyticsQuery,
  type AnalyticsQuery,
  type AnalyticsRow,
  type CreateAnalyticsQueryOptions,
} from './query'
export { withStepTelemetry } from './recorder'
// Re-exported, not defined here — see the note at the top of this file.
export {
  createMemoryTelemetrySink,
  NOOP_TELEMETRY,
  type TelemetrySink,
} from '../engine/telemetry'
export {
  runVolumeSql,
  spendSql,
  workflowStepsSql,
  type AnalyticsWindow,
} from './sql'
