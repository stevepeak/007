import { z } from 'zod'

import { errorLogText } from '../engine/error-detail'
import { resolveWfLogger } from '../engine/logger'
import { errorMessage } from '../engine/run-node'
import { recordChange, type DashboardAnalytics } from '../storage/data'
import { WF_CHANGE_ENTITY_KINDS, WF_EVAL_TARGET_KINDS } from '../storage/schema'

import { buildAgentHandlers } from './handlers/agents'
import { buildChangeHandlers } from './handlers/changes'
import { buildConnectorHandlers } from './handlers/connectors'
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
import { createWfDataClient } from './data-client'
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
  listDecisionModels: NO_INPUT,
  listDecisionProviders: NO_INPUT,
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

  // ---- MCP connectors -----------------------------------------------------
  getConnectorCapability: NO_INPUT,
  listConnectors: NO_INPUT,
  getConnector: z.object({ connectorId: z.string() }),
  saveConnector: z.object({
    id: z.string().optional(),
    label: z.string(),
    url: z.string(),
    transport: z.enum(['http', 'sse']).optional(),
    authKind: z.enum(['oauth2', 'bearer', 'none']).optional(),
    scopes: z.string().nullable().optional(),
    icon: z.string().nullable().optional(),
    iconName: z.string().nullable().optional(),
    color: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
  }),
  deleteConnector: z.object({ connectorId: z.string() }),
  setConnectorEnabled: z.object({
    connectorId: z.string(),
    enabled: z.boolean(),
  }),
  refreshConnector: z.object({ connectorId: z.string() }),
  setConnectorToolEnabled: z.object({
    toolId: z.string(),
    enabled: z.boolean(),
  }),
  setConnectorToolSideEffect: z.object({
    toolId: z.string(),
    sideEffect: z.enum(['read', 'write']),
  }),
  startConnectorAuth: z.object({
    connectorId: z.string(),
    returnTo: z.string().optional(),
  }),
  saveConnectorToken: z.object({ connectorId: z.string(), token: z.string() }),
  disconnectConnector: z.object({ connectorId: z.string() }),

  // ---- triggers -----------------------------------------------------------
  listTriggerEvents: NO_INPUT,

  // ---- workflows ----------------------------------------------------------
  listWorkflows: NO_INPUT,
  getWorkflow: z.object({ workflowId: z.string() }),
  discardDraft: z.object({ workflowId: z.string() }),
  listVersions: z.object({ workflowId: z.string() }),
  getVersion: z.object({ versionId: z.string() }),
  validateGraph: z.object({
    workflowId: z.string().optional(),
    versionId: z.string().optional(),
    graph: PASSED_THROUGH.optional(),
  }),
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
  listChildRuns: z.object({ parentRunId: z.string() }),
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
  getEvalRunDrive: z.object({ evalRunId: z.string() }),
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
    // The sweep manifest rides through as-is; `parseEvalPlan` is what validates
    // it, on the way back out, where a malformed blob must mean "this run is
    // not resumable" rather than an exception.
    plan: PASSED_THROUGH.optional(),
  }),
  saveEvalRunDrive: z.object({
    evalRunId: z.string(),
    driveState: PASSED_THROUGH,
    release: z.boolean().optional(),
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
    ...buildConnectorHandlers(opts),
  }
  return handlers
}

/**
 * Look a method up and validate its params against the registered schema.
 *
 * Throws `BadRequestError` rather than answering a `Response`, so the two
 * callers below can render a rejection in their own vocabulary — an HTTP 400
 * for the mounted route, a thrown error for the in-process client.
 */
function resolveCall(
  handlers: WfHandlers,
  method: string | undefined,
  rawParams: unknown,
): { handler: HandlerFn; params: unknown } {
  if (!method) throw new BadRequestError('Missing method')
  const handler = (handlers as Record<string, HandlerFn>)[method]
  if (!handler) throw new BadRequestError(`Unknown method '${method}'`)
  const params = rawParams ?? {}
  const schema = wfInputSchemas[method as keyof WfDataClient]
  if (!schema) return { handler, params }
  const parsed = schema.safeParse(params)
  if (!parsed.success) {
    throw new BadRequestError(
      `Invalid params for '${method}': ${parsed.error.message}`,
    )
  }
  return { handler, params: parsed.data }
}

/**
 * Run one resolved call and return its VALUE.
 *
 * Everything a handler is given — the db handle, the lazy env/analytics
 * resolvers, the change recorder bound to the acting user — is assembled here,
 * so the in-process client gets byte-for-byte the same treatment as an HTTP
 * caller. That equivalence is the whole reason this is shared rather than
 * reimplemented: a change recorded over MCP has to land in `wf_change` exactly
 * as a click in the editor does, attributed to the same actor.
 */
async function invokeHandler<TDeps>(
  opts: CreateWfSdkHandlersOptions<TDeps>,
  handler: HandlerFn,
  params: unknown,
  ctx: WfServerContext,
  req: Request,
): Promise<unknown> {
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
  // Bound once per call so a handler can never record a change without the
  // actor who made it — and without the surface they came in through, which
  // is what lets the activity feed say "over MCP" instead of guessing.
  const actor = {
    userId: ctx.userId ?? null,
    source: ctx.source ?? ('ui' as const),
  }
  const logger = resolveWfLogger(opts.config.logger)
  const change: HandlerCtx['change'] = (input) => {
    return recordChange(db, { ...input, actor }, logger)
  }
  return await handler({
    params,
    ctx,
    db,
    req,
    env,
    analytics,
    change,
    logger,
  })
}

/**
 * A `WfDataClient` that dispatches IN-PROCESS, with a context the caller has
 * already established.
 *
 * The MCP server is the reason this exists. It runs inside the same Worker as
 * the mounted route, having just verified an OAuth access token, so it already
 * knows who the caller is — sending itself an HTTP request to re-derive that
 * would cost a subrequest and a second trip through auth to learn nothing new.
 *
 * `ctx` is supplied rather than resolved because the identity came from a
 * bearer token, not from the cookie `opts.resolveContext` reads. `req` is the
 * real inbound request, so anything a handler reads off it is still honest.
 *
 * Errors THROW here (`BadRequestError`, `NotFoundError`, `UnauthorizedError`,
 * or whatever a handler raised) instead of becoming status codes. The MCP
 * server already renders a thrown error as tool content, which is the form a
 * model can actually act on.
 */
export function createLocalWfDataClient<TDeps>(
  opts: CreateWfSdkHandlersOptions<TDeps>,
  local: { ctx: WfServerContext; req: Request },
): WfDataClient {
  const handlers = buildHandlers(opts)
  return createWfDataClient(async (method, params) => {
    const call = resolveCall(handlers, method, params)
    return await invokeHandler(opts, call.handler, call.params, local.ctx, local.req)
  })
}

export function createWfSdkHandlers<TDeps>(
  opts: CreateWfSdkHandlersOptions<TDeps>,
): (req: Request) => Promise<Response> {
  const handlers = buildHandlers(opts)
  // Resolved once per mount: `opts.config` is fixed for the life of the route,
  // so the guard around a throwing host logger is allocated once too.
  const logger = resolveWfLogger(opts.config.logger)
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
    // Narrowed by `resolveCall` below, which rejects a missing or unknown
    // name — but the catch needs it for `onError`, so it is read out here.
    const method = envelope.method ?? '(missing)'

    let call: { handler: HandlerFn; params: unknown }
    try {
      call = resolveCall(handlers, envelope.method, envelope.params)
    } catch (err) {
      // Validation and lookup failures are the caller's, not ours — answered
      // as a 400 here rather than falling into the 500 path below.
      return json({ error: errorMessage(err) }, 400)
    }

    // Hoisted out of the `try` so the catch can attribute a failure to the
    // caller who hit it. Stays undefined when `resolveContext` was what threw.
    let ctx: WfServerContext | undefined
    try {
      ctx = await opts.resolveContext(req)
      return json(await invokeHandler(opts, call.handler, call.params, ctx, req))
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
      logger.error(`[wf] ${method} failed: ${errorLogText(err)}`)
      // Hand the fault to the host's error tracker as well. The log line above
      // is not enough on its own — nothing in it is grouped, alerted, or
      // attributable to a user.
      try {
        opts.onError?.({ err, method, ctx, req })
      } catch (reportErr) {
        // A reporting failure must never escalate into a dropped response.
        logger.error(`[wf] onError hook threw: ${errorLogText(reportErr)}`)
      }
      return json({ error: errorMessage(err) }, 500)
    }
  }
}
