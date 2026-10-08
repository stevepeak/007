import { z } from 'zod'

import { WF_AGENT_KINDS } from '../../engine/agent-kind'
import {
  WF_CHANGE_ENTITY_KINDS,
  WF_EVAL_TARGET_KINDS,
} from '../../storage/schema'
import type { WfDataClient } from '../protocol'

// Per-method input schemas, validated in the dispatcher BEFORE the handler runs,
// so a malformed body fails fast with a 400 instead of surfacing as an opaque
// 500 deep in a handler or a DB query (the flagged risk: an untyped `since` /
// `limit` / `enabled` cast straight into logic).
//
// The table is TOTAL — `Record<keyof WfDataClient, …>`, not `Partial<…>`. It
// used to be partial, which meant a method with no entry silently skipped
// dispatcher validation, and a forgotten entry was indistinguishable from a
// deliberate one. Now adding a method to `WfDataClient` fails to compile until
// it declares how its wire input is checked, and `NO_INPUT` records "nothing to
// validate" as an explicit decision.
//
// Totality is enforced with `satisfies` rather than a type ANNOTATION, and that
// is load-bearing: an annotation would widen every entry to `z.ZodType` and
// throw away the shape each schema describes, leaving `WfInput` below with
// nothing to infer. `satisfies` checks the same two things the annotation did —
// no missing method, no stray one — while keeping each entry's own type.
//
// Two properties worth keeping in mind when adding one:
//
//   * The schema describes the WIRE shape, not the TS signature. Methods that
//     take a positional id (`getWorkflow(workflowId)`) are wrapped into
//     `{ workflowId }` by `createHttpWfDataClient`, so that is what to declare.
//   * `.min(1)` on a required string is not decoration. Handlers used to reach
//     their ids through `requireStr(c.params, 'agentId')`, which rejected an
//     EMPTY string as well as a missing one; `z.string()` alone accepts `''`
//     and would have let a blank id reach a lookup. Every `.min(1)` below is
//     one of those guards, moved to the only place both the server and a
//     client-side form can read it from.
//   * `z.object` STRIPS unknown keys, and the dispatcher forwards `parsed.data`.
//     So a schema must name every field its handler reads — an unnamed one is
//     not merely unvalidated, it is deleted before the handler sees it. Rich
//     payloads (`graph`, `config`, eval `checks`) are therefore named as
//     `z.unknown()`: they pass through intact and their real validation stays
//     where it already lives, in `parseGraph` / `parseAgentConfig` / the eval
//     schemas, whose failures the dispatcher still maps to 400.

/**
 * A method that takes no wire params, or whose entire payload is validated
 * downstream. Deliberately unable to reject anything — it exists so the total
 * table can record "checked elsewhere" rather than leaving a hole.
 */
const NO_INPUT = z.unknown()

/** Free-form JSON validated downstream (`parseGraph`, `parseAgentConfig`, …). */
const PASSED_THROUGH = z.unknown()

/**
 * `WfChangeSummary` — small enough to state here rather than pass through.
 *
 * It used to ride along as `PASSED_THROUGH` and get cast back to shape inside
 * the handler, which is the exact pattern ART-188 is about: two independent
 * claims about one payload, with nothing comparing them. Named here, the cast
 * goes away and a malformed summary is a 400 instead of two `undefined`
 * columns.
 */
const AI_SUMMARY = z.object({ short: z.string(), long: z.string() })

export const wfInputSchemas = {
  // ---- models -------------------------------------------------------------
  listModels: NO_INPUT,
  listProviders: NO_INPUT,
  listDecisionModels: NO_INPUT,
  listDecisionProviders: NO_INPUT,
  getModelCatalog: NO_INPUT,
  getProviderBudgets: NO_INPUT,
  refreshModels: z.object({ providerId: z.string().min(1) }),
  setModelEnabled: z.object({ modelId: z.string().min(1), enabled: z.boolean() }),

  // ---- tools --------------------------------------------------------------
  listTools: NO_INPUT,
  listToolContextFields: NO_INPUT,
  listReferenceKinds: NO_INPUT,
  listToolInvocations: z.object({
    toolId: z.string().min(1),
    limit: z.number().optional(),
  }),
  runToolPreview: z.object({
    toolId: z.string().min(1),
    // The tool's own `inputSchema` is what really checks these; here they only
    // have to survive the trip as an object.
    args: z.record(z.string(), z.unknown()),
    context: z.record(z.string(), z.string()).optional(),
  }),

  // ---- MCP connectors -----------------------------------------------------
  getConnectorCapability: NO_INPUT,
  listConnectors: NO_INPUT,
  getConnector: z.object({ connectorId: z.string().min(1) }),
  saveConnector: z.object({
    id: z.string().optional(),
    label: z.string().min(1),
    url: z.string().min(1),
    transport: z.enum(['http', 'sse']).optional(),
    authKind: z.enum(['oauth2', 'bearer', 'none']).optional(),
    scopes: z.string().nullable().optional(),
    icon: z.string().nullable().optional(),
    iconName: z.string().nullable().optional(),
    color: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
  }),
  deleteConnector: z.object({ connectorId: z.string().min(1) }),
  setConnectorEnabled: z.object({
    connectorId: z.string().min(1),
    enabled: z.boolean(),
  }),
  refreshConnector: z.object({ connectorId: z.string().min(1) }),
  setConnectorToolEnabled: z.object({
    toolId: z.string().min(1),
    enabled: z.boolean(),
  }),
  setConnectorToolSideEffect: z.object({
    toolId: z.string().min(1),
    sideEffect: z.enum(['read', 'write']),
  }),
  startConnectorAuth: z.object({
    connectorId: z.string().min(1),
    returnTo: z.string().optional(),
  }),
  saveConnectorToken: z.object({ connectorId: z.string().min(1), token: z.string().min(1) }),
  disconnectConnector: z.object({ connectorId: z.string().min(1) }),

  // ---- triggers -----------------------------------------------------------
  listTriggerEvents: NO_INPUT,

  // ---- workflows ----------------------------------------------------------
  listWorkflows: NO_INPUT,
  getWorkflow: z.object({ workflowId: z.string().min(1) }),
  discardDraft: z.object({ workflowId: z.string().min(1) }),
  listVersions: z.object({ workflowId: z.string().min(1) }),
  getVersion: z.object({ versionId: z.string().min(1) }),
  validateGraph: z.object({
    workflowId: z.string().optional(),
    versionId: z.string().optional(),
    graph: PASSED_THROUGH.optional(),
  }),
  createWorkflow: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    graph: PASSED_THROUGH,
  }),
  updateDraft: z.object({
    workflowId: z.string().min(1),
    graph: PASSED_THROUGH,
  }),
  saveVersion: z.object({
    workflowId: z.string().min(1),
    graph: PASSED_THROUGH,
    changeNote: z.string().optional(),
    aiSummary: AI_SUMMARY.optional(),
  }),
  summarizeChanges: z.object({
    workflowId: z.string().min(1),
    graph: PASSED_THROUGH,
  }),
  updateWorkflow: z.object({
    workflowId: z.string().min(1),
    name: z.string().optional(),
    description: z.string().nullable().optional(),
    archived: z.boolean().optional(),
  }),

  // ---- runs ---------------------------------------------------------------
  listRunTriggerKinds: NO_INPUT,
  deleteAllRuns: NO_INPUT,
  listRuns: z.object({
    workflowVersionId: z.string().optional(),
    workflowId: z.string().optional(),
    triggerKind: z.string().optional(),
    status: z.string().optional(),
    search: z.string().optional(),
    since: z.number().optional(),
    until: z.number().optional(),
    limit: z.number().optional(),
    offset: z.number().optional(),
  }),
  listChildRuns: z.object({ parentRunId: z.string().min(1) }),
  getRun: z.object({
    runId: z.string().min(1),
    // Cache hint only — see `WfClient.getRun`. A stale or unknown id simply
    // fails the equality check server-side and yields a full load.
    knownVersionId: z.string().optional(),
    // Incremental-read hint only. A cursor from a different run (or a stale
    // one) can withhold steps the caller then never sees, so it is bounded to
    // non-negative and the client only ever derives it from its own last
    // response for this run.
    settledStepCursor: z.number().int().nonnegative().optional(),
  }),
  getRunStatus: z.object({ runId: z.string().min(1) }),
  retryRun: z.object({
    runId: z.string().min(1),
    mode: z.enum(['restart', 'resume']).optional(),
  }),
  setRunNote: z.object({
    runId: z.string().min(1),
    // Nullable rather than optional: clearing the note is an explicit `null`,
    // so an omitted field can never be read as "erase it".
    note: z.string().nullable(),
  }),

  // ---- dashboard ----------------------------------------------------------
  getDashboard: z.object({
    since: z.number().optional(),
    until: z.number().optional(),
    bucket: z.enum(['hour', 'day']).optional(),
  }),

  // ---- agents -------------------------------------------------------------
  listAgents: NO_INPUT,
  getAgent: z.object({ agentId: z.string().min(1) }),
  listAgentVersions: z.object({ agentId: z.string().min(1) }),
  getAgentVersion: z.object({ versionId: z.string().min(1) }),
  countAgentReferences: z.object({ agentId: z.string().min(1) }),
  listAgentReferences: z.object({ agentId: z.string().min(1) }),
  archiveAgent: z.object({ agentId: z.string().min(1) }),
  discardAgentDraft: z.object({ agentId: z.string().min(1) }),
  listAgentCalls: z.object({
    agentId: z.string().min(1),
    limit: z.number().optional(),
  }),
  createAgent: z.object({
    name: z.string().min(1),
    // Which config schema `config` is then checked against. Enumerated here
    // rather than passed through, because it is the only field that decides
    // how the payload beside it is read — and it is immutable afterward.
    kind: z.enum(WF_AGENT_KINDS).optional(),
    description: z.string().optional(),
    icon: z.string().optional(),
    color: z.string().optional(),
    config: PASSED_THROUGH,
  }),
  updateAgentDraft: z.object({
    agentId: z.string().min(1),
    config: PASSED_THROUGH,
  }),
  publishAgent: z.object({
    agentId: z.string().min(1),
    config: PASSED_THROUGH,
    changeNote: z.string().optional(),
    aiSummary: AI_SUMMARY.optional(),
  }),
  summarizeAgentChanges: z.object({
    agentId: z.string().min(1),
    config: PASSED_THROUGH,
  }),
  updateAgentMeta: z.object({
    agentId: z.string().min(1),
    name: z.string().optional(),
    description: z.string().optional(),
    icon: z.string().optional(),
    color: z.string().optional(),
  }),
  // The whole payload is an `AgentPreviewInput` the preview runner validates as
  // one unit (it has to build a real agent config out of it), so naming the
  // fields here would only risk stripping one.
  runAgentPreview: NO_INPUT,
  // Same reasoning: the payload is one `DecisionPreviewInput` the handler
  // validates as a unit, and `state` is any JSON value — naming it would only
  // risk stripping it.
  runDecisionPreview: NO_INPUT,

  // ---- evals --------------------------------------------------------------
  getEvalSet: z.object({
    setId: z.string().min(1),
    includeArchived: z.boolean().optional(),
  }),
  deleteEvalSet: z.object({ setId: z.string().min(1) }),
  deleteEvalRow: z.object({ rowId: z.string().min(1) }),
  restoreEvalRow: z.object({ rowId: z.string().min(1) }),
  getEvalRun: z.object({ evalRunId: z.string().min(1) }),
  getEvalRunDrive: z.object({ evalRunId: z.string().min(1) }),
  finalizeEvalRun: z.object({ evalRunId: z.string().min(1) }),
  cancelEvalRun: z.object({ evalRunId: z.string().min(1) }),
  listEvalSets: z.object({ includeArchived: z.boolean().optional() }),
  listChanges: z.object({
    entityKind: z.enum(WF_CHANGE_ENTITY_KINDS).optional(),
    entityId: z.string().optional(),
    parentId: z.string().optional(),
    actorId: z.string().optional(),
    limit: z.number().optional(),
  }),
  listEvalRuns: z.object({ limit: z.number().optional() }),
  createEvalSet: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    targetKind: z.enum(WF_EVAL_TARGET_KINDS),
    targetId: z.string().min(1),
    targetVersion: z.number().nullable().optional(),
    triggerKind: z.string().min(1),
  }),
  updateEvalSet: z.object({
    setId: z.string().min(1),
    name: z.string().optional(),
    description: z.string().nullable().optional(),
    targetKind: z.enum(WF_EVAL_TARGET_KINDS).optional(),
    targetId: z.string().optional(),
    targetVersion: z.number().nullable().optional(),
    triggerKind: z.string().optional(),
    archived: z.boolean().optional(),
  }),
  upsertEvalRow: z.object({
    id: z.string().optional(),
    setId: z.string().min(1),
    name: z.string().min(1),
    description: z.string().nullable().optional(),
    // Sample input, tool overrides and the check tree each have their own
    // schema in `engine/eval-schema`; they ride through as-is.
    input: PASSED_THROUGH.optional(),
    tools: PASSED_THROUGH.optional(),
    checks: PASSED_THROUGH.optional(),
    sortOrder: z.number().optional(),
  }),
  createEvalRun: z.object({
    setIds: z.array(z.string()),
    total: z.number().optional(),
    // The sweep manifest rides through as-is; `parseEvalPlan` is what validates
    // it, on the way back out, where a malformed blob must mean "this run is
    // not resumable" rather than an exception.
    plan: PASSED_THROUGH.optional(),
  }),
  saveEvalRunDrive: z.object({
    evalRunId: z.string().min(1),
    driveState: PASSED_THROUGH,
    release: z.boolean().optional(),
  }),
  startEvalRun: z.object({
    evalRunId: z.string().min(1),
    rowId: z.string().min(1),
    modelId: z.string().optional(),
    promptBody: z.string().optional(),
    // The unsaved-draft override — a whole AgentConfig, parsed by the runner.
    config: PASSED_THROUGH.optional(),
  }),
  runDecisionEvalCell: z.object({
    evalRunId: z.string().min(1),
    rowId: z.string().min(1),
    modelId: z.string().optional(),
    attempt: z.number().optional(),
    // The unsaved-draft override — a whole DecisionAgentConfig, parsed by the
    // handler against the target agent's kind.
    config: PASSED_THROUGH.optional(),
  }),
  gradeEvalResult: z.object({
    evalRunId: z.string().min(1),
    rowId: z.string().min(1),
    wfRunId: z.string().min(1),
    modelId: z.string().optional(),
    promptLabel: z.string().optional(),
    promptBody: z.string().optional(),
    attempt: z.number().optional(),
    // The judge the CHECKS run on, distinct from `modelId` (the model the
    // TARGET ran on, which is a matrix column).
    judgeModelId: z.string().optional(),
  }),
  recordEvalFailure: z.object({
    evalRunId: z.string().min(1),
    rowId: z.string().min(1),
    wfRunId: z.string().optional(),
    error: z.string().min(1),
    modelId: z.string().optional(),
    promptLabel: z.string().optional(),
    promptBody: z.string().optional(),
    attempt: z.number().optional(),
  }),

  // ---- feedback -----------------------------------------------------------
  submitFeedback: z.object({
    subjectId: z.string().min(1),
    rating: z.enum(['up', 'down']).nullable(),
    note: z.string().nullable().optional(),
    correlationId: z.string().nullable().optional(),
    runId: z.string().nullable().optional(),
    body: z.string().nullable().optional(),
    subjectTitle: z.string().nullable().optional(),
    subjectUrl: z.string().nullable().optional(),
    correlationLabel: z.string().nullable().optional(),
    raterLabel: z.string().nullable().optional(),
  }),
  listFeedback: z.object({
    ratings: z.array(z.enum(['up', 'down'])).optional(),
    ackState: z.enum(['acknowledged', 'unacknowledged']).optional(),
    // Both facet filters are AND-ed into ONE statement, so unlike the id
    // lookups elsewhere they can't be chunked independently — these caps are
    // what keeps that statement inside D1's 100-bound-parameter limit
    // (40 + 40 ids, plus the ratings/search/limit binds). See `listFeedback`.
    correlationIds: z.array(z.string()).max(40).optional(),
    raterIds: z.array(z.string()).max(40).optional(),
    search: z.string().optional(),
  }),
  setFeedbackAcknowledged: z.object({
    subjectId: z.string().min(1),
    acknowledged: z.boolean(),
  }),
  setFeedbackInternalNote: z.object({
    subjectId: z.string().min(1),
    note: z.string().nullable(),
  }),
  // The read itself chunks, so this cap is only a guard against an absurd
  // payload — deliberately well above any real conversation length, because a
  // tight cap would 400 a long chat instead of hydrating its thumbs. Note it
  // guards the HTTP path only: in-process hosts call the storage function
  // directly and never pass through here, which is why the chunking lives
  // down in `getFeedbackForSubjects` rather than up here.
  getFeedbackForSubjects: z.object({
    subjectIds: z.array(z.string()).max(1000),
  }),
} satisfies Record<keyof WfDataClient, z.ZodType>

/**
 * The validated shape a handler for `K` receives on `c.params`.
 *
 * This is the whole point of the table being `satisfies`-checked rather than
 * annotated `Record<keyof WfDataClient, z.ZodType>`: the annotation would widen
 * every entry to `z.ZodType` and infer `unknown` here, which is exactly the
 * hole this type closes. `HandlerCtx<K>` reads it, so a handler that reaches
 * for a field its schema never declared — and which `z.object` therefore
 * STRIPS before the handler runs — no longer compiles.
 *
 * `z.infer` (output, not `z.input`) because the dispatcher forwards
 * `parsed.data`: what a handler sees is what the schema produced, defaults and
 * coercions already applied.
 */
export type WfInput<K extends keyof WfDataClient> = z.infer<
  (typeof wfInputSchemas)[K]
>


/**
 * What a CLIENT may send for `K` — `z.input`, the shape BEFORE the schema
 * applies defaults or coercions (`WfInput` is the same schema's output, which
 * is what the handler then receives).
 *
 * `createWfDataClient` types its `send` with this, so every wire call it builds
 * is checked against the schema that will judge it at the other end. That is
 * the half of the drift this ticket's typing can't catch on the server side:
 * a handler now provably reads only fields its schema names, but nothing
 * otherwise stopped the client from SENDING a field the schema rejects — or
 * from wrapping a positional id under the wrong key (`getVersion` sending
 * `{ versionID }`), which the schema would strip and the handler would then
 * see as missing.
 */
export type WfInputWire<K extends keyof WfDataClient> = z.input<
  (typeof wfInputSchemas)[K]
>
