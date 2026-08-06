import { z } from 'zod'

import {
  agentConfigSchema,
  workflowGraphShapeSchema,
  type AgentConfig,
  type WorkflowGraph,
} from '../../engine/graph'
import type { WfDb } from '../../storage/client'
import { agentExists, workflowExists } from '../../storage/data'
import type { JsonSchema, WfDataClient, WfRunSummary } from '../protocol'

import type { WfServerContext } from './handler-options'

// The host-injection contract for the data handlers (`CreateWfSdkHandlersOptions`)
// and the request context (`WfServerContext`) live in `handler-options.ts`;
// re-exported here so consumers keep importing them from `./shared`.
export type {
  CreateWfSdkHandlersOptions,
  WfServerContext,
} from './handler-options'

// Converts a tool's Zod schema to JSON Schema for the wire. Zod v4 ships a
// native converter. `io` picks which side of any transform/pipe to project — an
// input schema is described as what the tool *accepts* (`'input'`), an output
// schema as what it *emits* (`'output'`). `unrepresentable: 'any'` is essential:
// without it a single `.transform()` anywhere in the tree (e.g. a coercing field
// like `partySchema` deep inside `docMeta`) makes the whole conversion THROW, so
// the tool would surface no input/output schema at all — the field just degrades
// to `{}` (any) instead. Anything still unconvertible falls back to "no schema"
// rather than failing the whole listing.
export function toJsonSchema(
  schema: z.ZodType | undefined,
  io: 'input' | 'output',
): JsonSchema | undefined {
  if (!schema) return undefined
  try {
    return z.toJSONSchema(schema, { io, unrepresentable: 'any' })
  } catch {
    return undefined
  }
}


export function toEpoch(d: Date | null | undefined): number | null {
  return d ? d.getTime() : null
}

// The wire shape of one run row. Shared by the runs list, the run detail load,
// and the dashboard's failures panel so all three describe a run identically.
// `traceUrl` is the host's Sentry deep-link builder (absent when it wires none).
export function runSummary(
  r: {
    id: string
    status: string
    triggerKind: string
    workflowId: string
    workflowName: string
    versionNumber: number
    subjectId: string | null
    correlationId: string | null
    createdAt: Date
    startedAt: Date | null
    finishedAt: Date | null
    error: string | null
    totalTokens?: number | null
    costUsd?: number | null
    sentryTraceId?: string | null
  },
  traceUrl?: (traceId: string) => string | null,
): WfRunSummary {
  const sentryTraceId = r.sentryTraceId ?? null
  return {
    id: r.id,
    status: r.status,
    triggerKind: r.triggerKind,
    workflowId: r.workflowId,
    workflowName: r.workflowName,
    versionNumber: r.versionNumber,
    subjectId: r.subjectId,
    correlationId: r.correlationId,
    createdAt: r.createdAt.getTime(),
    startedAt: toEpoch(r.startedAt),
    finishedAt: toEpoch(r.finishedAt),
    error: r.error,
    totalTokens: r.totalTokens ?? null,
    costUsd: r.costUsd ?? null,
    sentryTraceId,
    sentryTraceUrl:
      sentryTraceId && traceUrl ? (traceUrl(sentryTraceId) ?? null) : null,
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// Author-time persistence validates SHAPE only (well-formed nodes/edges), not
// graph-integrity (single trigger, legal joins, reachable outputs). This lets
// the editor save a work-in-progress that still has issues; those surface
// non-blockingly in the editor's Issues panel. The strict `workflowGraphSchema`
// remains the runtime gate when a run actually starts.
export function parseGraph(params: unknown): WorkflowGraph {
  const graph = (params as { graph?: unknown }).graph
  return workflowGraphShapeSchema.parse(graph)
}

// A client-input problem (bad/missing params) — distinct from an unexpected
// server fault so the dispatcher can answer 400 rather than 500.
export class BadRequestError extends Error {}

// A referenced entity doesn't exist — the dispatcher answers 404 (not a logged
// 500 fault). Distinct from `BadRequestError` so "you asked for something gone"
// reads differently from "your params were malformed."
export class NotFoundError extends Error {}

export function str(params: unknown, key: string): string {
  const v = (params as Record<string, unknown>)[key]
  if (typeof v !== 'string' || !v) {
    throw new BadRequestError(`Missing '${key}' parameter.`)
  }
  return v
}

// Coerce an untrusted `{ [k]: v }` bag into a string→string record, dropping
// non-string values. Used for the playground's prompt-variable inputs.
export function parseStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

export function parseAgentConfig(params: unknown): AgentConfig {
  return agentConfigSchema.parse((params as { config?: unknown }).config)
}

// Per-request state each method handler receives. A handler parses what it needs
// off `params`, does the work, and returns a plain value — the dispatcher below
// owns the shared frame (auth/db resolution, JSON wrapping, error handling), so
// the four-step ritual (validate → scope → call → shape) that used to be spelled
// out in every `switch` arm now lives in exactly one place.
export type HandlerCtx = {
  params: unknown
  ctx: WfServerContext
  db: WfDb
  req: Request
  /** Lazily-resolved, request-memoized host bindings (Cloudflare `env`). */
  env: () => Promise<unknown>
}

// A handler may be sync or async — the dispatcher always awaits its result
// (`await` on a non-promise is a no-op), so this covers both.
export type MaybePromise<T> = T | Promise<T>

// The dispatcher reaches handlers by string key, so it needs a shape-agnostic
// call signature.
export type HandlerFn = (c: HandlerCtx) => unknown

// The typed handler table: every method must return the SAME shape its protocol
// method declares, so a server/client DTO drift is a compile error rather than a
// runtime surprise the client only discovers on the wire. Methods the protocol
// types as `void` discard their return over the wire, so those may hand back
// anything (several return `{ ok: true }` for readability at the call site).
export type HandlerResult<T> = [T] extends [void] ? unknown : T
export type WfHandlers = {
  [K in keyof WfDataClient]: (
    c: HandlerCtx,
  ) => MaybePromise<HandlerResult<Awaited<ReturnType<WfDataClient[K]>>>>
}

// Require an optional host hook to be wired, or fail with a clear message —
// collapses the four near-identical "not configured on this host" guards.
export function requireHook<T>(hook: T | undefined, message: string): T {
  if (!hook) throw new Error(message)
  return hook
}

// Guard a mutation against a missing target before writing. Uses the cheap
// existence check (indexed `SELECT id`) rather than a full entity load, and
// throws `NotFoundError` so the caller sees a 404, not a 500.
export async function requireExists(
  db: WfDb,
  workflowId: string,
): Promise<void> {
  if (!(await workflowExists(db, workflowId))) {
    throw new NotFoundError('Workflow not found')
  }
}

export async function requireAgentExists(
  db: WfDb,
  agentId: string,
): Promise<void> {
  if (!(await agentExists(db, agentId))) {
    throw new NotFoundError('Agent not found')
  }
}
