import { z } from 'zod'

import type { WfSdkConfig } from '../../engine/config'
import {
  agentConfigSchema,
  workflowGraphShapeSchema,
  type AgentConfig,
  type WorkflowGraph,
} from '../../engine/graph'
import type { WfDb } from '../../storage/client'
import { getAgent, getWorkflow } from '../../storage/data'

import type {
  AgentPreviewResult,
  JsonSchema,
  RetryRunMode,
  WfChangeSummary,
  WfDataClient,
  WfEvalTargetKind,
  ToolContextField,
  WfToolPreviewResult,
} from '../protocol'

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

// Server-side implementation of the data protocol. The host mounts the returned
// handler at one POST route (e.g. `app/api/wf/route.ts`) and supplies:
//   • resolveDb      — the request-scoped WfDb (from its D1 binding)
//   • resolveContext — the authenticated { userId } for attribution
// Workflows and agents are a single global set; the host gatekeeps who may
// reach this route (e.g. admins only), so the SDK itself stays auth-free.

export type WfServerContext = { userId?: string }

export type CreateWfSdkHandlersOptions<TDeps> = {
  config: Pick<
    WfSdkConfig<TDeps>,
    | 'getModel'
    | 'listModels'
    | 'listProviders'
    | 'fetchModelCatalog'
    | 'toolRegistry'
    | 'triggers'
  >
  resolveDb: (req: Request) => WfDb | Promise<WfDb>
  resolveContext: (req: Request) => WfServerContext | Promise<WfServerContext>
  /**
   * Optional: the host's live bindings (Cloudflare `env`), passed to
   * `config.getModel` so the SDK can generate publish-dialog change summaries
   * itself. The SDK owns the summarization (prompt, diff, schema, persistence);
   * the host only supplies the same model seam it already wires for agents. If
   * omitted (and no `summarizeChanges` override), summaries fall back to a
   * heuristic structural diff.
   */
  resolveEnv?: (req: Request) => unknown
  /**
   * Optional: which model the SDK summarizes changes with. Defaults to the
   * host's first offered model (`listModels()[0]`).
   */
  summaryModelId?: string
  /**
   * Optional: build a "View trace in Sentry" deep-link for a run from its stable
   * trace id. The host owns the URL shape (org slug, region, route) since only it
   * knows its Sentry config. Returns null to omit the link. Surfaced on
   * `WfRunDetail.run.sentryTraceUrl`.
   */
  sentryTraceUrl?: (traceId: string) => string | null
  /**
   * Optional override for the built-in AI summarizer — supply this only to
   * replace the SDK's summarization entirely (most hosts don't need to). Returns
   * a git-style `{ short, long }`.
   */
  summarizeChanges?: (input: {
    previousGraph: WorkflowGraph | null
    nextGraph: WorkflowGraph
    ctx: WfServerContext
    req: Request
  }) => Promise<WfChangeSummary>
  /**
   * Optional background-work scheduler. When a version is published *without* a
   * ready AI summary, the SDK uses this to generate + persist the summary after
   * the response is sent (on Cloudflare, pass `ctx.waitUntil`). If omitted, the
   * summary is simply left null until the next explicit `summarizeChanges` call.
   */
  waitUntil?: (promise: Promise<unknown>) => void
  /**
   * Optional playground runner for the agent editor — runs one agent draft in
   * isolation against a scratch input. The host supplies live bindings (`env`)
   * and typically delegates to the SDK's `executeAgentPreview` helper (per the
   * injection contract, the model + tools come from the host). If omitted, the
   * `runAgentPreview` method rejects with a "not configured" error.
   */
  runAgentPreview?: (input: {
    config: AgentConfig
    input: string
    promptVariables: Record<string, string>
    ctx: WfServerContext
    req: Request
  }) => Promise<AgentPreviewResult>
  /**
   * Optional playground runner for the tool detail page — runs one tool FOR REAL
   * against scratch args. Unlike `runAgentPreview` (which simulates tools), this
   * executes the actual tool with the host's live per-run deps, so it can hit
   * external services, incur cost, and mutate real data. The host supplies live
   * bindings (`env`) and typically delegates to the SDK's `executeToolPreview`
   * helper. If omitted, the `runToolPreview` method rejects with a "not
   * configured" error.
   */
  runToolPreview?: (input: {
    toolId: string
    args: Record<string, unknown>
    /**
     * The playground's context inputs (keyed by the `key`s declared in
     * `toolContextFields`). The host maps these into the RunContext it hands
     * `executeToolPreview` — e.g. `context.clientOrgId` → `correlationId`.
     */
    context: Record<string, string>
    ctx: WfServerContext
    req: Request
  }) => Promise<WfToolPreviewResult>
  /**
   * Optional: the context inputs the tool playground should collect before a
   * real run — the ambient scope (client, acting user, …) that a tool reads from
   * its per-run deps rather than from its AI-visible arguments. Surfaced to the
   * UI verbatim via `listToolContextFields`; the values come back through
   * `runToolPreview`'s `context` bag for the host to map into the RunContext.
   * Omit if the host's tools need no ambient context.
   */
  toolContextFields?: ToolContextField[]
  /**
   * Optional re-dispatch hook for the run viewer's Retry button. The SDK loads
   * the finished run, reconstructs its trigger input from the recorded trigger
   * step, and resolves the workflow's latest version, then hands the host a
   * ready-to-run descriptor; the host owns the actual workflow-instance start
   * (it has the runtime bindings) and returns the new run id. Modes:
   * - `restart` → start fresh on `latestVersionId` from the beginning.
   * - `resume`  → start on `originalVersionId` passing `resumeFromRunId` so the
   *   engine replays the prior run's completed steps and picks up at the failure.
   * If omitted, the `retryRun` method rejects with "not configured".
   */
  retryRun?: (input: {
    mode: RetryRunMode
    source: {
      runId: string
      workflowId: string
      /** The version the failed run executed (used by `resume`). */
      originalVersionId: string
      /** The workflow's current latest version (used by `restart`). */
      latestVersionId: string | null
      triggerKind: string
      triggerInput: unknown
      subjectId: string | null
      correlationId: string | null
    }
    ctx: WfServerContext
    req: Request
  }) => Promise<{ runId: string }>
  /**
   * Optional eval-run launcher. The SDK resolves the row, its set's target, and
   * the concrete `workflowVersionId` to run (for an agent target it creates/reuses
   * the hidden Phase-5 wrapper workflow), then hands the host a ready descriptor.
   * The host only starts the graph run — `WORKFLOWS.startGraphRun({
   * workflowVersionId, triggerKind, triggerInput, promptVariables, simulate: true,
   * isEval: true, fixtures })` — and returns the new `wf_run` id (its
   * `workflowRunId`, the id `getRun`/`gradeEvalResult` read). The host owns the
   * start because it holds the runtime bindings. If omitted, `startEvalRun`
   * rejects with "not configured".
   */
  startEvalRun?: (input: {
    evalRunId: string
    rowId: string
    target: { kind: WfEvalTargetKind; id: string }
    /** The concrete version to run — the workflow's latest, or the agent wrapper's. */
    workflowVersionId: string
    /** The trigger kind to start under (agent wrappers are always `manual`). */
    triggerKind: string
    /** The row's initial-condition trigger input (`{}` when unset). */
    triggerInput: unknown
    /** The row's initial-condition prompt variables (`{}` when unset). */
    promptVariables: Record<string, string>
    /** Canned read-tool outputs, keyed by tool id (consumed under `simulate`). */
    fixtures: Record<string, unknown>
    ctx: WfServerContext
    req: Request
  }) => Promise<{ wfRunId: string }>
  /**
   * Optional: which model `gradeEvalResult` uses for `llm_judge` checks that
   * don't pin their own `modelId`. Defaults to the host's first offered model
   * (`listModels()[0]`).
   */
  evalJudgeModelId?: string
}

export function toEpoch(d: Date | null | undefined): number | null {
  return d ? d.getTime() : null
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

// Guard a mutation against a missing target before writing.
export async function requireExists(
  db: WfDb,
  workflowId: string,
): Promise<void> {
  const result = await getWorkflow(db, workflowId)
  if (!result) {
    throw new Error('Workflow not found')
  }
}

export async function requireAgentExists(
  db: WfDb,
  agentId: string,
): Promise<void> {
  const result = await getAgent(db, agentId)
  if (!result) {
    throw new Error('Agent not found')
  }
}
