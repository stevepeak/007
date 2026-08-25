import { z } from 'zod'

import { errorLogText } from '../engine/error-detail'
import { errorMessage } from '../engine/run-node'
import { recordChange, type DashboardAnalytics } from '../storage/data'
import {
  WF_CHANGE_ENTITY_KINDS,
  WF_EVAL_TARGET_KINDS,
} from '../storage/schema'

import { buildAgentHandlers } from './handlers/agents'
import { buildChangeHandlers } from './handlers/changes'
import { buildDashboardHandlers } from './handlers/dashboard'
import { buildEvalHandlers } from './handlers/evals'
import { buildFeedbackHandlers } from './handlers/feedback'
import { buildModelHandlers } from './handlers/models'
import { buildRunHandlers } from './handlers/runs'
import {
  BadRequestError,
  json,
  NotFoundError,
  UnauthorizedError,
  type CreateWfSdkHandlersOptions,
  type HandlerCtx,
  type HandlerFn,
  type WfHandlers,
  type WfServerContext,
} from './handlers/shared'
import { buildWorkflowHandlers } from './handlers/workflows'
import type { WfDataClient } from './protocol'

export type {
  CreateWfSdkHandlersOptions,
  WfServerContext,
} from './handlers/shared'
// Re-exported (a value, not a type) because a host's `resolveContext` needs to
// be able to throw it — it's the one dispatcher error class hosts author.
export { UnauthorizedError } from './handlers/shared'

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
// Two properties worth keeping in mind when adding one:
//
//   * The schema describes the WIRE shape, not the TS signature. Methods that
//     take a positional id (`getWorkflow(workflowId)`) are wrapped into
//     `{ workflowId }` by `createHttpWfDataClient`, so that is what to declare.
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

const wfInputSchemas: Record<keyof WfDataClient, z.ZodType> = {
  // ---- models -------------------------------------------------------------
  listModels: NO_INPUT,
  listProviders: NO_INPUT,
  getModelCatalog: NO_INPUT,
  getProviderBudgets: NO_INPUT,
  refreshModels: z.object({ providerId: z.string() }),
  setModelEnabled: z.object({ modelId: z.string(), enabled: z.boolean() }),

  // ---- tools --------------------------------------------------------------
  listTools: NO_INPUT,
  listToolContextFields: NO_INPUT,
  listToolInvocations: z.object({
    toolId: z.string(),
    limit: z.number().optional(),
  }),
  runToolPreview: z.object({
    toolId: z.string(),
    // The tool's own `inputSchema` is what really checks these; here they only
    // have to survive the trip as an object.
    args: z.record(z.string(), z.unknown()),
    context: z.record(z.string(), z.string()).optional(),
  }),

  // ---- triggers -----------------------------------------------------------
  listTriggerEvents: NO_INPUT,

  // ---- workflows ----------------------------------------------------------
  listWorkflows: NO_INPUT,
  getWorkflow: z.object({ workflowId: z.string() }),
  discardDraft: z.object({ workflowId: z.string() }),
  listVersions: z.object({ workflowId: z.string() }),
  getVersion: z.object({ versionId: z.string() }),
  createWorkflow: z.object({
    name: z.string(),
    description: z.string().optional(),
    graph: PASSED_THROUGH,
  }),
  updateDraft: z.object({
    workflowId: z.string(),
    graph: PASSED_THROUGH,
  }),
  saveVersion: z.object({
    workflowId: z.string(),
    graph: PASSED_THROUGH,
    changeNote: z.string().optional(),
    aiSummary: PASSED_THROUGH.optional(),
  }),
  summarizeChanges: z.object({
    workflowId: z.string(),
    graph: PASSED_THROUGH,
  }),
  updateWorkflow: z.object({
    workflowId: z.string(),
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
  getRun: z.object({
    runId: z.string(),
    // Cache hint only — see `WfClient.getRun`. A stale or unknown id simply
    // fails the equality check server-side and yields a full load.
    knownVersionId: z.string().optional(),
    // Incremental-read hint only. A cursor from a different run (or a stale
    // one) can withhold steps the caller then never sees, so it is bounded to
    // non-negative and the client only ever derives it from its own last
    // response for this run.
    settledStepCursor: z.number().int().nonnegative().optional(),
  }),
  getRunStatus: z.object({ runId: z.string() }),
  retryRun: z.object({
    runId: z.string(),
    mode: z.enum(['restart', 'resume']).optional(),
  }),
  setRunNote: z.object({
    runId: z.string(),
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
  getAgent: z.object({ agentId: z.string() }),
  listAgentVersions: z.object({ agentId: z.string() }),
  getAgentVersion: z.object({ versionId: z.string() }),
  countAgentReferences: z.object({ agentId: z.string() }),
  listAgentReferences: z.object({ agentId: z.string() }),
  archiveAgent: z.object({ agentId: z.string() }),
  discardAgentDraft: z.object({ agentId: z.string() }),
  listAgentCalls: z.object({
    agentId: z.string(),
    limit: z.number().optional(),
  }),
  createAgent: z.object({
    name: z.string(),
    description: z.string().optional(),
    icon: z.string().optional(),
    color: z.string().optional(),
    config: PASSED_THROUGH,
  }),
  updateAgentDraft: z.object({
    agentId: z.string(),
    config: PASSED_THROUGH,
  }),
  publishAgent: z.object({
    agentId: z.string(),
    config: PASSED_THROUGH,
    changeNote: z.string().optional(),
    aiSummary: PASSED_THROUGH.optional(),
  }),
  summarizeAgentChanges: z.object({
    agentId: z.string(),
    config: PASSED_THROUGH,
  }),
  updateAgentMeta: z.object({
    agentId: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    icon: z.string().optional(),
    color: z.string().optional(),
  }),
  // The whole payload is an `AgentPreviewInput` the preview runner validates as
  // one unit (it has to build a real agent config out of it), so naming the
  // fields here would only risk stripping one.
  runAgentPreview: NO_INPUT,

  // ---- evals --------------------------------------------------------------
  getEvalSet: z.object({ setId: z.string() }),
  deleteEvalSet: z.object({ setId: z.string() }),
  deleteEvalRow: z.object({ rowId: z.string() }),
  getEvalRun: z.object({ evalRunId: z.string() }),
  finalizeEvalRun: z.object({ evalRunId: z.string() }),
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
    name: z.string(),
    description: z.string().optional(),
    targetKind: z.enum(WF_EVAL_TARGET_KINDS),
    targetId: z.string(),
    targetVersion: z.number().nullable().optional(),
    triggerKind: z.string(),
  }),
  updateEvalSet: z.object({
    setId: z.string(),
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
    setId: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
    // Sample input, tool overrides and the check tree each have their own
    // schema in `eval/checks`; they ride through as-is.
    input: PASSED_THROUGH.optional(),
    tools: PASSED_THROUGH.optional(),
    checks: PASSED_THROUGH.optional(),
    sortOrder: z.number().optional(),
  }),
  createEvalRun: z.object({
    setIds: z.array(z.string()),
    total: z.number().optional(),
  }),
  startEvalRun: z.object({
    evalRunId: z.string(),
    rowId: z.string(),
    modelId: z.string().optional(),
    promptBody: z.string().optional(),
    // The unsaved-draft override — a whole AgentConfig, parsed by the runner.
    config: PASSED_THROUGH.optional(),
  }),
  gradeEvalResult: z.object({
    evalRunId: z.string(),
    rowId: z.string(),
    wfRunId: z.string(),
    modelId: z.string().optional(),
    promptLabel: z.string().optional(),
    promptBody: z.string().optional(),
    attempt: z.number().optional(),
  }),
  recordEvalFailure: z.object({
    evalRunId: z.string(),
    rowId: z.string(),
    wfRunId: z.string().optional(),
    error: z.string(),
    modelId: z.string().optional(),
    promptLabel: z.string().optional(),
    promptBody: z.string().optional(),
    attempt: z.number().optional(),
  }),

  // ---- feedback -----------------------------------------------------------
  submitFeedback: z.object({
    subjectId: z.string(),
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
    subjectId: z.string(),
    acknowledged: z.boolean(),
  }),
  setFeedbackInternalNote: z.object({
    subjectId: z.string(),
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
}

// The method table. Typed against `keyof WfDataClient` so the compiler proves
// the server implements exactly the protocol the client calls — no drift, no
// silently-missing or stray method. Each entry is the old `switch` arm's body,
// returning the value the dispatcher JSON-wraps.
function buildHandlers<TDeps>(
  opts: CreateWfSdkHandlersOptions<TDeps>,
): WfHandlers {
  // Each per-domain factory returns a `Pick<WfHandlers, …its methods>`, so its
  // method SHAPES are checked AND its declared key-set must match its object
  // literal exactly. The composition below is annotated `: WfHandlers` with no
  // assertion, so the spread of those Picks must collectively cover every
  // `keyof WfDataClient` — a method dropped from any domain is a compile error
  // here ("Property 'x' is missing"). That restores the original single-object
  // literal's "no drift, no silently-missing method" guarantee across the split.
  const handlers: WfHandlers = {
    ...buildModelHandlers(opts),
    ...buildWorkflowHandlers(opts),
    ...buildRunHandlers(opts),
    ...buildDashboardHandlers(opts),
    ...buildAgentHandlers(opts),
    ...buildChangeHandlers(),
    ...buildEvalHandlers(opts),
    ...buildFeedbackHandlers(opts),
  }
  return handlers
}

export function createWfSdkHandlers<TDeps>(
  opts: CreateWfSdkHandlersOptions<TDeps>,
): (req: Request) => Promise<Response> {
  const handlers = buildHandlers(opts)
  return async (req) => {
    if (req.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405)
    }
    let envelope: { method?: string; params?: unknown }
    try {
      envelope = await req.json()
    } catch {
      return json({ error: 'Invalid JSON body' }, 400)
    }
    const method = envelope.method
    let params: unknown = envelope.params ?? {}
    if (!method) {
      return json({ error: 'Missing method' }, 400)
    }
    const handler = (handlers as Record<string, HandlerFn>)[method]
    if (!handler) {
      return json({ error: `Unknown method '${method}'` }, 400)
    }

    // Validate the body against the method's registered input schema (if any)
    // before dispatch, so malformed params answer 400 instead of 500.
    const schema = wfInputSchemas[method as keyof WfDataClient]
    if (schema) {
      const parsed = schema.safeParse(params)
      if (!parsed.success) {
        return json(
          { error: `Invalid params for '${method}': ${parsed.error.message}` },
          400,
        )
      }
      params = parsed.data
    }

    // Hoisted out of the `try` so the catch can attribute a failure to the
    // caller who hit it. Stays undefined when `resolveContext` was what threw.
    let ctx: WfServerContext | undefined
    try {
      ctx = await opts.resolveContext(req)
      const db = await opts.resolveDb(req)
      // Resolve host bindings at most once per request, lazily — several
      // handlers never touch `env`, and the ones that do reference it once.
      let envResolved = false
      let envValue: unknown
      const env = async () => {
        if (!envResolved) {
          envValue = opts.resolveEnv ? await opts.resolveEnv(req) : undefined
          envResolved = true
        }
        return envValue
      }
      let analyticsResolved = false
      let analyticsValue: DashboardAnalytics | null = null
      const analytics = async () => {
        if (!analyticsResolved) {
          analyticsValue = opts.resolveAnalytics
            ? await opts.resolveAnalytics(req)
            : null
          analyticsResolved = true
        }
        return analyticsValue
      }
      // Bound once per request so a handler can never record a change without
      // the actor who made it.
      const actor = { userId: ctx?.userId ?? null, source: 'ui' as const }
      const change: HandlerCtx['change'] = (input) =>
        recordChange(db, { ...input, actor })
      const result = await handler({
        params,
        ctx,
        db,
        req,
        env,
        analytics,
        change,
      })
      return json(result)
    } catch (err) {
      // Bad client input (a `requireStr()` guard or a handler-level zod parse) is a
      // 400, not a server fault — don't log it as a 500.
      if (err instanceof BadRequestError || err instanceof z.ZodError) {
        return json({ error: errorMessage(err) }, 400)
      }
      // A referenced entity is gone — a 404, not a server fault to log.
      if (err instanceof NotFoundError) {
        return json({ error: errorMessage(err) }, 404)
      }
      // Not signed in / not staff — a 403 access outcome, not a fault. Answered
      // before `onError` so a tab polling on a dead session can't fill the
      // host's error tracker. See `UnauthorizedError`.
      if (err instanceof UnauthorizedError) {
        return json({ error: errorMessage(err) }, 403)
      }
      // Surface the failure in the server log — otherwise a 500 from any
      // handler is invisible (the client only sees a generic error string).
      // `errorLogText`, not the raw error: the production log pipeline renders
      // a caught Error as bare stack frames and drops the message AND `cause`.
      console.error(`[wf] ${method} failed:`, errorLogText(err))
      // Hand the fault to the host's error tracker as well. The log line above
      // is not enough on its own — nothing in it is grouped, alerted, or
      // attributable to a user.
      try {
        opts.onError?.({ err, method, ctx, req })
      } catch (reportErr) {
        // A reporting failure must never escalate into a dropped response.
        console.error(`[wf] onError hook threw:`, errorLogText(reportErr))
      }
      return json({ error: errorMessage(err) }, 500)
    }
  }
}
