// Barrel for the SDK's `wf_*` D1 schema. The table/type/const definitions live
// in cohesive per-domain siblings (`./schema-*`); this file re-exports them so
// `./schema` stays the single import surface for drizzle queries and the
// drizzle-kit `schema` entry (drizzle.config.ts). See `./schema-common` for the
// shared tenancy/run-identity conventions and the `createdAt` helper.

export {
  TOP_LEVEL_ITEM_INDEX,
  WF_EVAL_RESULT_STATUSES,
  WF_EVAL_TARGET_KINDS,
  WF_FEEDBACK_RATINGS,
  WF_RUN_STATUSES,
  WF_RUN_STEP_STATUSES,
  type WfRunStatus,
} from './schema-common'
export {
  wfAgent,
  wfAgentDraft,
  wfAgentVersion,
} from './schema-agents'
export {
  WF_CHANGE_ACTIONS,
  WF_CHANGE_ENTITY_KINDS,
  WF_CHANGE_SOURCES,
  wfChange,
  type WfChangeAction,
  type WfChangeEntityKind,
  type WfChangeSource,
} from './schema-change'
export {
  WF_CONNECTION_OWNER_SCOPES,
  WF_CONNECTION_STATUSES,
  WF_CONNECTION_WORKSPACE_OWNER,
  WF_CONNECTOR_AUTH_KINDS,
  WF_CONNECTOR_TRANSPORTS,
  wfConnector,
  wfConnectorClient,
  wfConnectorConnection,
  wfConnectorOauthState,
  wfConnectorTool,
  type WfConnectionOwnerScope,
  type WfConnectionStatus,
  type WfConnectorAuthKind,
  type WfConnectorTransport,
} from './schema-connectors'
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
import { wfChange } from './schema-change'
import {
  wfConnector,
  wfConnectorClient,
  wfConnectorConnection,
  wfConnectorOauthState,
  wfConnectorTool,
} from './schema-connectors'
import {
  wfEvalResult,
  wfEvalRow,
  wfEvalRun,
  wfEvalSet,
} from './schema-evals'
import { wfFeedback } from './schema-feedback'
import { wfModel, wfModelProvider } from './schema-models'
import { wfRun, wfRunLog, wfRunStep } from './schema-runs'
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
  wfRunLog,
  wfEvalSet,
  wfEvalRow,
  wfEvalRun,
  wfEvalResult,
  wfModelProvider,
  wfModel,
  wfFeedback,
  wfChange,
  wfConnector,
  wfConnectorConnection,
  wfConnectorTool,
  wfConnectorClient,
  wfConnectorOauthState,
}
