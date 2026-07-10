// @app/wf-sdk — a whitelabeled AI-workflow SDK.
//
// Subpath entries keep heavy concerns isolated so hosts import only what they
// need:
//   • '@app/wf-sdk'           — engine + config + storage (this barrel)
//   • '@app/wf-sdk/engine'    — pure execution engine (no DB, no Cloudflare)
//   • '@app/wf-sdk/storage'   — Drizzle schema + data access + durable recorder
//   • '@app/wf-sdk/cloudflare'— GraphWorkflow + RunRoom (Workers runtime only)
//   • '@app/wf-sdk/eval'      — testing harness

export * from './engine'
export * from './storage'
export { runWorkflowUnderConditions } from './eval'
export type { WorkflowTestCase, WorkflowTestRun } from './eval'
