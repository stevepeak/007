import { z } from 'zod'

import { errorLogText } from '../engine/error-detail'
import { resolveWfLogger } from '../engine/logger'
import { errorMessage } from '../engine/run-node'
import { recordChange, type DashboardAnalytics } from '../storage/data'

import { buildAgentHandlers } from './handlers/agents'
import { buildChangeHandlers } from './handlers/changes'
import { buildConnectorHandlers } from './handlers/connectors'
import { buildDashboardHandlers } from './handlers/dashboard'
import { buildEvalHandlers } from './handlers/evals'
import { buildFeedbackHandlers } from './handlers/feedback'
import { wfInputSchemas } from './handlers/input-schemas'
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
      // Bad client input (a handler-level zod parse, or a guard a handler
      // raised itself) is a 400, not a server fault — don't log it as a 500.
      // Dispatcher-level schema rejections never reach here: `resolveCall` runs
      // before this `try` and answers its own 400.
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
