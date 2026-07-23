import { z } from 'zod'

import { errorMessage } from '../engine/run-node'

import { buildAgentHandlers } from './handlers/agents'
import { buildEvalHandlers } from './handlers/evals'
import { buildFeedbackHandlers } from './handlers/feedback'
import { buildModelHandlers } from './handlers/models'
import { buildRunHandlers } from './handlers/runs'
import {
  BadRequestError,
  json,
  NotFoundError,
  type CreateWfSdkHandlersOptions,
  type HandlerFn,
  type WfHandlers,
} from './handlers/shared'
import { buildWorkflowHandlers } from './handlers/workflows'
import type { WfDataClient } from './protocol'

export type {
  CreateWfSdkHandlersOptions,
  WfServerContext,
} from './handlers/shared'

// Per-method input schemas, validated in the dispatcher BEFORE the handler runs,
// so a malformed body fails fast with a 400 instead of surfacing as an opaque
// 500 deep in a handler or a DB query (the flagged risk: an untyped `since` /
// `limit` / `enabled` cast straight into logic). This is the single source of
// truth for a method's wire input; add an entry as methods gain non-trivial
// params. Objects are non-strict (unknown keys pass), so a schema only asserts
// the fields it names — declaring one can't reject an otherwise-valid call.
// Methods with no entry are passed through unchanged (validated by their own
// `parseGraph`/`parseAgentConfig`/`str`, whose failures the dispatcher still
// maps to 400).
const wfInputSchemas: Partial<Record<keyof WfDataClient, z.ZodType>> = {
  refreshModels: z.object({ providerId: z.string() }),
  setModelEnabled: z.object({ modelId: z.string(), enabled: z.boolean() }),
  listToolInvocations: z.object({
    toolId: z.string(),
    limit: z.number().optional(),
  }),
  getWorkflow: z.object({ workflowId: z.string() }),
  discardDraft: z.object({ workflowId: z.string() }),
  listVersions: z.object({ workflowId: z.string() }),
  getVersion: z.object({ versionId: z.string() }),
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
  getRun: z.object({ runId: z.string() }),
  retryRun: z.object({
    runId: z.string(),
    mode: z.enum(['restart', 'resume']).optional(),
  }),
  getAgent: z.object({ agentId: z.string() }),
  listAgentVersions: z.object({ agentId: z.string() }),
  countAgentReferences: z.object({ agentId: z.string() }),
  listAgentReferences: z.object({ agentId: z.string() }),
  archiveAgent: z.object({ agentId: z.string() }),
  getEvalSet: z.object({ setId: z.string() }),
  deleteEvalSet: z.object({ setId: z.string() }),
  deleteEvalRow: z.object({ rowId: z.string() }),
  getEvalRun: z.object({ evalRunId: z.string() }),
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
    correlationIds: z.array(z.string()).optional(),
    raterIds: z.array(z.string()).optional(),
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
  getFeedbackForSubjects: z.object({ subjectIds: z.array(z.string()) }),
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
    ...buildAgentHandlers(opts),
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

    try {
      const ctx = await opts.resolveContext(req)
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
      const result = await handler({ params, ctx, db, req, env })
      return json(result)
    } catch (err) {
      // Bad client input (a `str()` guard or a handler-level zod parse) is a
      // 400, not a server fault — don't log it as a 500.
      if (err instanceof BadRequestError || err instanceof z.ZodError) {
        return json({ error: errorMessage(err) }, 400)
      }
      // A referenced entity is gone — a 404, not a server fault to log.
      if (err instanceof NotFoundError) {
        return json({ error: errorMessage(err) }, 404)
      }
      // Surface the failure in the server log — otherwise a 500 from any
      // handler is invisible (the client only sees a generic error string).
      console.error(`[wf] ${method} failed:`, err)
      return json({ error: errorMessage(err) }, 500)
    }
  }
}
