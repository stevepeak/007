// Run telemetry: the point layout, the sink seam, and the recorder decorator.
// Everything here is runtime-neutral and dependency-free — the Cloudflare
// Analytics Engine implementation lives in `../cloudflare/analytics-engine.ts`.
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
export {
  createMemoryTelemetrySink,
  NOOP_TELEMETRY,
  type TelemetrySink,
} from './sink'
export {
  runVolumeSql,
  spendSql,
  workflowStepsSql,
  type AnalyticsWindow,
} from './sql'
