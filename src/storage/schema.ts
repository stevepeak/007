// Barrel for the SDK's `wf_*` D1 schema. The table/type/const definitions live
// in cohesive per-domain siblings (`./schema-*`); this file re-exports them so
// `./schema` stays the single import surface for drizzle queries and the
// drizzle-kit `schema` entry (drizzle.config.ts). See `./schema-common` for the
// shared tenancy/run-identity conventions and the `createdAt` helper.

export {
  WF_EVAL_RESULT_STATUSES,
  WF_EVAL_TARGET_KINDS,
  WF_FEEDBACK_RATINGS,
  WF_RUN_STATUSES,
  WF_RUN_STEP_STATUSES,
} from './schema-common'
export {
  wfAgent,
  wfAgentDraft,
  wfAgentVersion,
} from './schema-agents'
export { wfFeedback } from './schema-feedback'
export {
  wfEvalResult,
  wfEvalRow,
  wfEvalRun,
  wfEvalSet,
} from './schema-evals'
export { wfModel, wfModelProvider } from './schema-models'
export { wfRun, wfRunLog, wfRunStep } from './schema-runs'
export {
  wfWorkflow,
  wfWorkflowAssignment,
  wfWorkflowDraft,
  wfWorkflowVersion,
} from './schema-workflows'

import { wfAgent, wfAgentDraft, wfAgentVersion } from './schema-agents'
import {
  wfEvalResult,
  wfEvalRow,
  wfEvalRun,
  wfEvalSet,
} from './schema-evals'
import { wfFeedback } from './schema-feedback'
import { wfModel, wfModelProvider } from './schema-models'
import { wfRun, wfRunStep } from './schema-runs'
import {
  wfWorkflow,
  wfWorkflowAssignment,
  wfWorkflowDraft,
  wfWorkflowVersion,
} from './schema-workflows'

export const wfSchema = {
  wfWorkflow,
  wfWorkflowVersion,
  wfWorkflowDraft,
  wfAgent,
  wfAgentVersion,
  wfAgentDraft,
  wfWorkflowAssignment,
  wfRun,
  wfRunStep,
  wfEvalSet,
  wfEvalRow,
  wfEvalRun,
  wfEvalResult,
  wfModelProvider,
  wfModel,
  wfFeedback,
}
