import { z } from 'zod'

import type { WfAgentKind } from '../../engine/agent-kind'
import {
  decisionAgentConfigSchema,
  type AnyAgentConfig,
  type DecisionAgentConfig,
} from '../../engine/decision-agent-schema'
import {
  agentConfigSchema,
  workflowGraphShapeSchema,
  type AgentConfig,
  type WorkflowGraph,
} from '../../engine/graph'
import type { WfLogger } from '../../engine/logger'
import type { WfDb } from '../../storage/client'
import type { DashboardAnalytics, RecordChangeInput } from '../../storage/data'
import { agentExists, workflowExists } from '../../storage/data'
import type {
  JsonSchema,
  WfDataClient,
  WfRunReleaseRef,
  WfRunSummary,
  WfRunTreeTotals,
} from '../protocol'

import type { WfServerContext } from './handler-options'
import type { WfInput } from './input-schemas'

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
    note?: string | null
    totalTokens?: number | null
    costUsd?: number | null
    sentryTraceId?: string | null
    hostRelease?: string | null
    sdkRelease?: string | null
    parentRunId?: string | null
    parentNodeId?: string | null
    /** The stored item index — `-1` is the "not an iteration item" sentinel. */
    itemIndex?: number | null
    /** The item's resolved name, when the container's template produced one. */
    itemTitle?: string | null
    /** The parent run's workflow name, when the caller resolved one. */
    parentWorkflowName?: string | null
    /** Totals across everything this run spawned; omitted when it spawned none. */
    tree?: WfRunTreeTotals | null
  },
  traceUrl?: (traceId: string) => string | null,
  releaseUrl?: (kind: 'host' | 'sdk', release: string) => string | null,
): WfRunSummary {
  const sentryTraceId = r.sentryTraceId ?? null
  const releaseRef = (
    kind: 'host' | 'sdk',
    id: string | null | undefined,
  ): WfRunReleaseRef | null =>
    id ? { id, url: releaseUrl ? (releaseUrl(kind, id) ?? null) : null } : null
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
    note: r.note ?? null,
    totalTokens: r.totalTokens ?? null,
    costUsd: r.costUsd ?? null,
    sentryTraceId,
    sentryTraceUrl:
      sentryTraceId && traceUrl ? (traceUrl(sentryTraceId) ?? null) : null,
    release: {
      host: releaseRef('host', r.hostRelease),
      sdk: releaseRef('sdk', r.sdkRelease),
    },
    // Both columns are written together at spawn time, so a row with a parent
    // run always has a parent node; requiring both here means a half-written
    // link reads as "top-level" rather than as a child pointing nowhere.
    parent:
      r.parentRunId && r.parentNodeId
        ? {
            runId: r.parentRunId,
            nodeId: r.parentNodeId,
            // `-1` is the top-level/callee sentinel — surfaced as null so the
            // wire shape reads as "not one of several items".
            itemIndex:
              r.itemIndex == null || r.itemIndex < 0 ? null : r.itemIndex,
            workflowName: r.parentWorkflowName ?? null,
            itemTitle: r.itemTitle ?? null,
          }
        : null,
    // Only the reads that resolved a tree pass one — a child-run row, for
    // instance, deliberately reports its own figures and leaves this null
    // rather than paying for a walk per row (see `listChildRuns`).
    tree: r.tree ?? null,
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
export function parseGraph(graph: unknown): WorkflowGraph {
  return workflowGraphShapeSchema.parse(graph)
}

// A client-input problem (bad/missing params) — distinct from an unexpected
// server fault so the dispatcher can answer 400 rather than 500.
export class BadRequestError extends Error {}

// A referenced entity doesn't exist — the dispatcher answers 404 (not a logged
// 500 fault). Distinct from `BadRequestError` so "you asked for something gone"
// reads differently from "your params were malformed."
export class NotFoundError extends Error {}

// The caller isn't signed in, or isn't allowed to reach the editor — the
// dispatcher answers 403 and, crucially, does NOT route it to `onError`. A
// host's `resolveContext` rejects on every unauthenticated poll (an expired
// session tab left open will do it indefinitely), and those are an access
// outcome, not a server fault: reporting them would bury real 500s in the
// host's error tracker. Hosts should throw this from `resolveContext` rather
// than a bare `Error`.
export class UnauthorizedError extends Error {}

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

export function parseAgentConfig(config: unknown): AgentConfig {
  return agentConfigSchema.parse(config)
}

/**
 * Keys that only a GENERATION config has. Their presence in a payload aimed at
 * a decision agent is the tell that the caller sent the wrong shape.
 *
 * The check is needed because zod cannot make it. `decisionAgentConfigSchema`
 * is deliberately permissive — the editor saves a draft on every keystroke, so
 * `questions`, `verdicts` and `rules` all default to empty — and `z.object`
 * STRIPS unknown keys. So a generation config sent to a decision agent parses
 * cleanly into `{ modelId, questions: [], verdicts: [], rules: [] }` and
 * silently erases the matrix. That is the one failure mode a kind discriminator
 * exists to prevent, so it is caught by name rather than by shape.
 */
const GENERATION_ONLY_KEYS = [
  'prompt',
  'userPrompt',
  'toolIds',
  'maxTurns',
  'output',
  'inputKind',
  'subAgents',
] as const

/** A DECISION agent's config off the wire. The sibling of {@link parseAgentConfig}. */
export function parseDecisionAgentConfig(
  config: unknown,
): DecisionAgentConfig {
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    const sent = config as Record<string, unknown>
    const generationKeys = GENERATION_ONLY_KEYS.filter((k) => k in sent)
    if (generationKeys.length > 0) {
      throw new BadRequestError(
        `This is a decision agent, but the config carries ${generationKeys.join(', ')} — that is a generation agent's shape. A decision config is { modelId, questions, verdicts, rules }.`,
      )
    }
  }
  return decisionAgentConfigSchema.parse(config)
}

/**
 * Parse an agent config against the schema its KIND names.
 *
 * Every write path that starts from an existing agent goes through this rather
 * than picking a schema itself: the two shapes are disjoint, so sending a
 * generation config to a decision agent is not a config with missing fields,
 * it is the wrong config entirely — and this is where that becomes a 400 rather
 * than a row nothing can read back.
 */
export function parseConfigOfKind(
  kind: WfAgentKind,
  config: unknown,
): AnyAgentConfig {
  return kind === 'decision'
    ? parseDecisionAgentConfig(config)
    : parseAgentConfig(config)
}

// Per-request state each method handler receives. A handler parses what it needs
// off `params`, does the work, and returns a plain value — the dispatcher below
// owns the shared frame (auth/db resolution, JSON wrapping, error handling), so
// the four-step ritual (validate → scope → call → shape) that used to be spelled
// out in every `switch` arm now lives in exactly one place.
export type HandlerCtx<K extends keyof WfDataClient = keyof WfDataClient> = {
  /**
   * The params the dispatcher already validated, typed from this method's entry
   * in `wfInputSchemas`.
   *
   * Handlers used to re-derive this by hand — `requireStr(c.params, 'id')` and
   * `(c.params as { icon?: string }).icon` — which meant the schema and the
   * handler each held their own private opinion of the wire shape and nothing
   * compared them. Reading the shape off the schema makes the two the same
   * statement, so the drift that used to be silent is now a type error (the
   * flagged risk in ART-188).
   */
  params: WfInput<K>
  ctx: WfServerContext
  db: WfDb
  req: Request
  /** Lazily-resolved, request-memoized host bindings (Cloudflare `env`). */
  env: () => Promise<unknown>
  /**
   * Lazily-resolved Analytics Engine reader, or null when the host wired none.
   * Memoized per request like `env`, since only the dashboard touches it.
   */
  analytics: () => Promise<DashboardAnalytics | null>
  /**
   * Append to the durable change log. The actor, the db and the source are
   * already bound, so a handler states only WHAT changed.
   *
   * Bound rather than passed because the alternative is threading
   * `c.ctx.userId` through a dozen call sites, and nothing in the type system
   * would catch the one that forgot. Never throws — an audit write must not
   * fail the mutation it describes.
   */
  change: (input: Omit<RecordChangeInput, 'actor'>) => Promise<void>
  /**
   * Where a handler reports a fault it has decided not to throw — a host
   * provider lookup that failed, a background summary that never landed.
   * `config.logger` already resolved (and guarded), so a handler never reaches
   * for `console`; the console is what it resolves to when no host wired one.
   *
   * Bound for the same reason `change` is: the alternative is threading it
   * through every handler builder, and nothing in the type system would catch
   * the one that forgot.
   */
  logger: WfLogger
}

// A handler may be sync or async — the dispatcher always awaits its result
// (`await` on a non-promise is a no-op), so this covers both.
export type MaybePromise<T> = T | Promise<T>

// The dispatcher reaches handlers by string key, so it needs a shape-agnostic
// call signature. `HandlerCtx<keyof WfDataClient>` gives `params` as the UNION
// of every method's input — which no single handler accepts — so the dispatcher
// casts through this type once, at the one place a string key is turned back
// into a call. That cast is the price of dynamic dispatch and is confined to
// `resolveCall`; every handler on the other side of it is fully typed.
export type HandlerFn = (c: HandlerCtx) => unknown

// The typed handler table: every method must return the SAME shape its protocol
// method declares, so a server/client DTO drift is a compile error rather than a
// runtime surprise the client only discovers on the wire. Methods the protocol
// types as `void` discard their return over the wire, so those may hand back
// anything (several return `{ ok: true }` for readability at the call site).
export type HandlerResult<T> = [T] extends [void] ? unknown : T
export type WfHandlers = {
  [K in keyof WfDataClient]: (
    c: HandlerCtx<K>,
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
