import { z } from 'zod'

import type {
  ModelProvider,
  ModelProviderStatus,
  WfSdkConfig,
} from '../engine/config'
import {
  agentConfigSchema,
  inferPromptVariables,
  workflowGraphShapeSchema,
  type AgentConfig,
  type WorkflowGraph,
} from '../engine/graph'
import { errorMessage } from '../engine/run-node'
import { describeTriggerEvents } from '../engine/trigger-registry'
import {
  gradeRow,
  resolveEvalTarget,
  rollup,
  type GradeModelFactory,
  type GradeStep,
} from '../eval'
import type { WfDb } from '../storage/client'
import {
  archiveAgent,
  buildEvalSnapshot,
  countWorkflowsReferencingAgent,
  createAgent,
  createEvalRun,
  createEvalSet,
  createWorkflow,
  deleteEvalRow,
  deleteEvalSet,
  discardAgentDraft,
  discardDraft,
  getAgent,
  getEvalRow,
  getEvalRun,
  getEvalSet,
  getLatestVersionId,
  getModelCatalog,
  getModelUsage,
  getRun,
  getVersionGraph,
  getWorkflow,
  hashEvalSnapshot,
  insertEvalResult,
  listAgents,
  listAgentVersions,
  listWorkflowsReferencingAgent,
  listWorkflowsReferencingAllAgents,
  listEnabledModels,
  listEvalRuns,
  listEvalSets,
  listModelProviders,
  listRuns,
  listRunTriggerKinds,
  listToolInvocations,
  listVersions,
  listWorkflows,
  publishAgent,
  saveVersion,
  setModelEnabled,
  setVersionAiSummary,
  touchModelProvider,
  updateAgentDraft,
  updateAgentMeta,
  updateDraft,
  updateEvalRun,
  updateEvalSet,
  updateWorkflow,
  upsertEvalRow,
  upsertModels,
} from '../storage/data'

import type {
  AgentPreviewResult,
  EvalRowSnapshot,
  JsonSchema,
  RetryRunMode,
  WfAgentDetail,
  WfAgentSummary,
  WfChangeSummary,
  WfDataClient,
  WfEvalResultDTO,
  WfEvalRowDTO,
  WfEvalRunSummary,
  WfEvalSetSummary,
  WfEvalTargetKind,
  WfRunDetail,
  WfRunLogDTO,
  ToolContextField,
  WfRunStepDTO,
  WfRunSummary,
  WfToolInvocation,
  WfToolPreviewResult,
  WfWorkflowDetail,
  WfWorkflowSummary,
} from './protocol'
import { summarizeWorkflowChanges } from './summarize-changes'

// Converts a tool's Zod schema to JSON Schema for the wire. Zod v4 ships a
// native converter. `io` picks which side of any transform/pipe to project — an
// input schema is described as what the tool *accepts* (`'input'`), an output
// schema as what it *emits* (`'output'`). `unrepresentable: 'any'` is essential:
// without it a single `.transform()` anywhere in the tree (e.g. a coercing field
// like `partySchema` deep inside `docMeta`) makes the whole conversion THROW, so
// the tool would surface no input/output schema at all — the field just degrades
// to `{}` (any) instead. Anything still unconvertible falls back to "no schema"
// rather than failing the whole listing.
function toJsonSchema(
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

// Fallback change summary when no host summarizer is provided: a plain count of
// structural deltas between the last published version and the graph to publish.
function heuristicChangeSummary(
  prev: WorkflowGraph | null,
  next: WorkflowGraph,
): WfChangeSummary {
  if (!prev) return { short: 'Initial version.', long: '' }
  const prevNodes = new Map(prev.nodes.map((n) => [n.id, n]))
  const nextNodes = new Map(next.nodes.map((n) => [n.id, n]))
  const added = [...nextNodes.keys()].filter((id) => !prevNodes.has(id)).length
  const removed = [...prevNodes.keys()].filter(
    (id) => !nextNodes.has(id),
  ).length
  let edited = 0
  for (const [id, nn] of nextNodes) {
    const pn = prevNodes.get(id)
    if (!pn) continue
    if (
      JSON.stringify({ l: pn.label, c: pn.config }) !==
      JSON.stringify({ l: nn.label, c: nn.config })
    ) {
      edited++
    }
  }
  const edgeDelta = next.edges.length - prev.edges.length
  const parts: string[] = []
  const plural = (n: number, w: string) => `${n} ${w}${n > 1 ? 's' : ''}`
  if (added) parts.push(`added ${plural(added, 'node')}`)
  if (removed) parts.push(`removed ${plural(removed, 'node')}`)
  if (edited) parts.push(`edited ${plural(edited, 'node')}`)
  if (edgeDelta > 0) parts.push(`added ${plural(edgeDelta, 'connection')}`)
  else if (edgeDelta < 0)
    parts.push(`removed ${plural(-edgeDelta, 'connection')}`)
  if (parts.length === 0) return { short: 'No structural changes.', long: '' }
  const joined = parts.join(', ')
  const short = joined.charAt(0).toUpperCase() + joined.slice(1) + '.'
  return { short, long: '' }
}

// One place that resolves a change summary. Order of precedence:
//   1. a host `summarizeChanges` override (rare — most hosts don't set it),
//   2. the SDK's own AI summarizer via the host's `getModel` seam (the default),
//   3. a structural heuristic when no model is available.
// Used by the `summarizeChanges` method and by the background summary generated
// when a version is published before its summary is ready. `env` is resolved by
// the caller (inside the request scope) and passed through to `getModel`.
async function computeChangeSummary<TDeps>(
  opts: CreateWfSdkHandlersOptions<TDeps>,
  input: {
    previousGraph: WorkflowGraph | null
    nextGraph: WorkflowGraph
    ctx: WfServerContext
    req: Request
    env: unknown
  },
): Promise<WfChangeSummary> {
  if (opts.summarizeChanges) {
    return await opts.summarizeChanges({
      previousGraph: input.previousGraph,
      nextGraph: input.nextGraph,
      ctx: input.ctx,
      req: input.req,
    })
  }
  const modelId =
    opts.summaryModelId ??
    (await opts.config.listModels({ env: input.env }))[0]?.id
  if (modelId) {
    return await summarizeWorkflowChanges({
      getModel: opts.config.getModel,
      modelId,
      env: input.env,
      previousGraph: input.previousGraph,
      nextGraph: input.nextGraph,
    })
  }
  return heuristicChangeSummary(input.previousGraph, input.nextGraph)
}

function toEpoch(d: Date | null | undefined): number | null {
  return d ? d.getTime() : null
}

function json(body: unknown, status = 200): Response {
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
function parseGraph(params: unknown): WorkflowGraph {
  const graph = (params as { graph?: unknown }).graph
  return workflowGraphShapeSchema.parse(graph)
}

// A client-input problem (bad/missing params) — distinct from an unexpected
// server fault so the dispatcher can answer 400 rather than 500.
class BadRequestError extends Error {}

function str(params: unknown, key: string): string {
  const v = (params as Record<string, unknown>)[key]
  if (typeof v !== 'string' || !v) {
    throw new BadRequestError(`Missing '${key}' parameter.`)
  }
  return v
}

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
}

// Coerce an untrusted `{ [k]: v }` bag into a string→string record, dropping
// non-string values. Used for the playground's prompt-variable inputs.
function parseStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

function workflowSummary(w: {
  id: string
  name: string
  description: string | null
  createdAt: Date
  archived: boolean
}): WfWorkflowSummary {
  return {
    id: w.id,
    name: w.name,
    description: w.description,
    createdAt: w.createdAt.getTime(),
    archived: w.archived,
  }
}

function agentSummary(
  a: {
    id: string
    name: string
    description: string | null
    icon: string | null
    color: string | null
    createdAt: Date
  },
  config?: unknown,
  workflows: { id: string; name: string }[] = [],
): WfAgentSummary {
  // `config` is an untyped JSON column; parse it defensively so a malformed row
  // degrades to "no variables/output" rather than throwing the whole listing.
  const parsed = config ? agentConfigSchema.safeParse(config) : null
  const cfg = parsed?.success ? parsed.data : null
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    icon: a.icon,
    color: a.color,
    createdAt: a.createdAt.getTime(),
    inputVariables: cfg ? inferPromptVariables(cfg.prompt) : [],
    output: cfg?.output ?? null,
    modelId: cfg?.modelId ?? null,
    toolIds: cfg?.toolIds ?? [],
    workflows,
  }
}

function parseAgentConfig(params: unknown): AgentConfig {
  return agentConfigSchema.parse((params as { config?: unknown }).config)
}

function runSummary(
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

function evalSetSummary(
  s: {
    id: string
    name: string
    description: string | null
    targetKind: WfEvalTargetKind
    targetId: string
    targetVersion: number | null
    triggerKind: string
    archived: boolean
    createdAt: Date
    updatedAt: Date | null
  },
  rowCount: number,
): WfEvalSetSummary {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    targetKind: s.targetKind,
    targetId: s.targetId,
    targetVersion: s.targetVersion,
    triggerKind: s.triggerKind,
    archived: s.archived,
    rowCount,
    createdAt: s.createdAt.getTime(),
    updatedAt: toEpoch(s.updatedAt),
  }
}

function evalRunSummary(r: {
  id: string
  status: string
  setIds: unknown
  total: number
  passed: number
  failed: number
  score: number | null
  createdAt: Date
  startedAt: Date | null
  finishedAt: Date | null
}): WfEvalRunSummary {
  return {
    id: r.id,
    status: r.status,
    setIds: Array.isArray(r.setIds) ? (r.setIds as string[]) : [],
    total: r.total,
    passed: r.passed,
    failed: r.failed,
    score: r.score,
    createdAt: r.createdAt.getTime(),
    startedAt: toEpoch(r.startedAt),
    finishedAt: toEpoch(r.finishedAt),
  }
}

function evalResultDTO(r: {
  id: string
  evalRunId: string
  rowId: string
  wfRunId: string | null
  status: WfEvalResultDTO['status']
  score: number | null
  checkResults: unknown
  snapshot?: unknown
  snapshotHash?: string | null
  createdAt: Date
}): WfEvalResultDTO {
  return {
    id: r.id,
    evalRunId: r.evalRunId,
    rowId: r.rowId,
    wfRunId: r.wfRunId,
    status: r.status,
    score: r.score,
    checkResults: Array.isArray(r.checkResults)
      ? (r.checkResults as WfEvalResultDTO['checkResults'])
      : [],
    snapshot: (r.snapshot as EvalRowSnapshot | null) ?? null,
    snapshotHash: r.snapshotHash ?? null,
    createdAt: r.createdAt.getTime(),
  }
}

// The top-level run steps a grader reads. Iteration inner-subgraph steps (those
// with a `parentNodeId`) are excluded — checks address the workflow's own nodes,
// not an iteration's per-item subgraph nodes.
function toGradeSteps(
  steps: Array<{
    nodeId: string
    nodeKind: string
    parentNodeId?: string | null
    input?: unknown
    output?: unknown
    meta?: unknown
  }>,
): GradeStep[] {
  return steps
    .filter((s) => !s.parentNodeId)
    .map((s) => ({
      nodeId: s.nodeId,
      nodeKind: s.nodeKind,
      input: s.input,
      output: s.output,
      meta: s.meta,
    }))
}

// Per-request state each method handler receives. A handler parses what it needs
// off `params`, does the work, and returns a plain value — the dispatcher below
// owns the shared frame (auth/db resolution, JSON wrapping, error handling), so
// the four-step ritual (validate → scope → call → shape) that used to be spelled
// out in every `switch` arm now lives in exactly one place.
type HandlerCtx = {
  params: unknown
  ctx: WfServerContext
  db: WfDb
  req: Request
  /** Lazily-resolved, request-memoized host bindings (Cloudflare `env`). */
  env: () => Promise<unknown>
}

// A handler may be sync or async — the dispatcher always awaits its result
// (`await` on a non-promise is a no-op), so this covers both.
type MaybePromise<T> = T | Promise<T>

// The dispatcher reaches handlers by string key, so it needs a shape-agnostic
// call signature.
type HandlerFn = (c: HandlerCtx) => unknown

// The typed handler table: every method must return the SAME shape its protocol
// method declares, so a server/client DTO drift is a compile error rather than a
// runtime surprise the client only discovers on the wire. Methods the protocol
// types as `void` discard their return over the wire, so those may hand back
// anything (several return `{ ok: true }` for readability at the call site).
type HandlerResult<T> = [T] extends [void] ? unknown : T
type WfHandlers = {
  [K in keyof WfDataClient]: (
    c: HandlerCtx,
  ) => MaybePromise<HandlerResult<Awaited<ReturnType<WfDataClient[K]>>>>
}

// Require an optional host hook to be wired, or fail with a clear message —
// collapses the four near-identical "not configured on this host" guards.
function requireHook<T>(hook: T | undefined, message: string): T {
  if (!hook) throw new Error(message)
  return hook
}

// The set of provider ids the host currently declares — the authority for which
// providers/models this client actually offers. Cached catalog rows are gated
// against it so a provider dropped from the host config (its rows lingering in
// the DB from a past refresh) no longer surfaces in pickers.
async function hostProviderIds<TDeps>(
  config: CreateWfSdkHandlersOptions<TDeps>['config'],
  c: HandlerCtx,
): Promise<Set<string>> {
  const host = await config.listProviders({ env: await c.env() })
  return new Set(host.map((p) => p.id))
}

// The method table. Typed against `keyof WfDataClient` so the compiler proves
// the server implements exactly the protocol the client calls — no drift, no
// silently-missing or stray method. Each entry is the old `switch` arm's body,
// returning the value the dispatcher JSON-wraps.
function buildHandlers<TDeps>(
  opts: CreateWfSdkHandlersOptions<TDeps>,
): WfHandlers {
  return {
    // Enabled models come from the DB catalog. Before the first refresh (no
    // provider rows yet) or if the tables are missing, fall back to the host's
    // static list so pickers keep working. Once the catalog is populated we
    // honor the user's curation — even an empty selection.
    listModels: async (c) => {
      try {
        const providers = await listModelProviders(c.db)
        if (providers.length === 0) {
          // No cached catalog yet — fall back to the host's static list.
          return await opts.config.listModels({ env: await c.env() })
        }
        // Show only enabled models from providers the host STILL declares. A
        // provider cached from a past refresh but no longer wired up (e.g.
        // OpenRouter on a Venice-only host) is dropped, along with its models.
        // An empty result honors the user's curation (all models disabled).
        const allowed = await hostProviderIds(opts.config, c)
        const enabled = await listEnabledModels(c.db)
        return enabled.filter(
          (m) => m.providerId != null && allowed.has(m.providerId),
        )
      } catch {
        return await opts.config.listModels({ env: await c.env() })
      }
    },

    listProviders: async (c) => {
      try {
        const host = await opts.config.listProviders({ env: await c.env() })
        // The host config is the source of truth for WHICH providers this
        // client offers. Prefer the DB rows (they carry refresh metadata) but
        // keep only the providers the host still declares; fall back to the
        // host list before the first refresh caches any rows.
        const allowed = new Set(host.map((p) => p.id))
        const db = await listModelProviders(c.db)
        const filtered = db.filter((p) => allowed.has(p.id))
        return filtered.length > 0 ? filtered : host
      } catch {
        return await listModelProviders(c.db)
      }
    },

    // The host config is the source of truth for WHICH providers this client
    // offers; the DB adds each one's last-refresh time, cached models, and
    // counts. A freshly-wired provider (e.g. OpenRouter) shows up with a
    // Refresh button BEFORE its first refresh, and a provider the host no
    // longer declares — but whose rows linger in the DB from a past refresh —
    // is dropped, along with its models, so clients only ever see what they
    // actually provide.
    getModelCatalog: async (c) => {
      const [dbCatalog, usage] = await Promise.all([
        getModelCatalog(c.db),
        getModelUsage(c.db),
      ])
      let hostProviders: ModelProvider[]
      try {
        hostProviders = await opts.config.listProviders({ env: await c.env() })
      } catch {
        // Can't determine the host's providers right now — fall back to the
        // cached DB catalog rather than blanking the page on a transient error.
        return {
          providers: dbCatalog.providers,
          models: dbCatalog.models,
          usage,
        }
      }
      const dbById = new Map(dbCatalog.providers.map((p) => [p.id, p]))
      const providers: ModelProviderStatus[] = hostProviders.map((hp) => {
        const db = dbById.get(hp.id)
        const models = dbCatalog.models.filter((m) => m.providerId === hp.id)
        return {
          ...hp,
          enabled: db?.enabled ?? true,
          lastRefreshedAt: db?.lastRefreshedAt ?? null,
          modelCount: models.length,
          enabledCount: models.filter((m) => m.enabled).length,
        }
      })
      const allowed = new Set(hostProviders.map((p) => p.id))
      const models = dbCatalog.models.filter(
        (m) => m.providerId != null && allowed.has(m.providerId),
      )
      return { providers, models, usage }
    },

    refreshModels: async (c) => {
      const providerId = str(c.params, 'providerId')
      const fetchCatalog = opts.config.fetchModelCatalog
      if (!fetchCatalog) {
        throw new Error(
          'This host does not support refreshing models (no `fetchModelCatalog` configured).',
        )
      }
      const env = await c.env()
      const entries = await fetchCatalog({ env }, providerId)
      // Keep the host's default models enabled on first insert so there is always
      // a working set. Defaults are bare ids; the catalog uses composite ids.
      const defaults = await opts.config.listModels({ env })
      const defaultEnabledIds = defaults.map((m) => `${providerId}:${m.id}`)
      const count = await upsertModels(
        c.db,
        providerId,
        entries,
        defaultEnabledIds,
      )
      const refreshedAt = new Date()
      const providers = await opts.config.listProviders({ env })
      const provider = providers.find((p) => p.id === providerId) ?? {
        id: providerId,
        label: providerId,
        kind: 'custom' as const,
      }
      await touchModelProvider(c.db, provider, refreshedAt)
      return { count, refreshedAt: refreshedAt.getTime() }
    },

    setModelEnabled: async (c) => {
      const modelId = str(c.params, 'modelId')
      const enabled = (c.params as { enabled?: boolean }).enabled === true
      // A model in use by an agent cannot be disabled — it would break that
      // agent's model resolution. The UI locks the toggle; enforce it here too.
      if (!enabled) {
        const users = (await getModelUsage(c.db))[modelId] ?? []
        if (users.length > 0) {
          const names = users.map((u) => u.name).join(', ')
          throw new Error(
            `Can't disable this model — it's in use by ${users.length} agent(s): ${names}. Point those agents at another model first.`,
          )
        }
      }
      await setModelEnabled(c.db, { modelId, enabled })
      return { ok: true as const }
    },

    listTools: () =>
      [...opts.config.toolRegistry].map(([id, entry]) => ({
        id,
        name: entry.name,
        description: entry.description,
        icon: entry.icon,
        kind: entry.kind,
        inputSchema: toJsonSchema(entry.inputSchema, 'input'),
        outputSchema: toJsonSchema(entry.outputSchema, 'output'),
      })),

    listToolInvocations: async (c) => {
      const toolId = str(c.params, 'toolId')
      const limit = (c.params as { limit?: number }).limit
      const rows = await listToolInvocations(c.db, { toolId, limit })
      const invocations: WfToolInvocation[] = rows.map((r) => {
        // `meta` is the untyped tool-step meta ({ toolId, args }); pull the
        // args out defensively so a malformed row degrades to `{}`.
        const meta = (r.meta ?? {}) as { args?: unknown }
        const args =
          meta.args && typeof meta.args === 'object'
            ? (meta.args as Record<string, unknown>)
            : {}
        return {
          runId: r.runId,
          nodeId: r.nodeId,
          status: r.status,
          args,
          output: r.output,
          error: r.error,
          startedAt: toEpoch(r.startedAt),
          finishedAt: toEpoch(r.finishedAt),
          workflowId: r.workflowId ?? null,
          workflowName: r.workflowName ?? null,
        }
      })
      return invocations
    },

    listToolContextFields: () => opts.toolContextFields ?? [],

    listTriggerEvents: () => describeTriggerEvents(opts.config.triggers),

    listWorkflows: async (c) => {
      const rows = await listWorkflows(c.db)
      return rows.map(workflowSummary)
    },

    getWorkflow: async (c) => {
      const workflowId = str(c.params, 'workflowId')
      const result = await getWorkflow(c.db, workflowId)
      if (!result) {
        return null
      }
      const detail: WfWorkflowDetail = {
        workflow: workflowSummary(result.workflow),
        draft: result.draft
          ? { graph: result.draft.graph as WorkflowGraph }
          : null,
        currentVersion: result.currentVersion
          ? {
              id: result.currentVersion.id,
              versionNumber: result.currentVersion.versionNumber,
              graph: result.currentVersion.graph as WorkflowGraph,
            }
          : null,
      }
      return detail
    },

    createWorkflow: async (c) => {
      const name = str(c.params, 'name')
      const graph = parseGraph(c.params)
      const description = (c.params as { description?: string }).description
      return await createWorkflow(c.db, {
        name,
        description,
        createdBy: c.ctx.userId,
        graph,
      })
    },

    updateDraft: async (c) => {
      const workflowId = str(c.params, 'workflowId')
      const graph = parseGraph(c.params)
      await requireExists(c.db, workflowId)
      await updateDraft(c.db, { workflowId, graph, lastEditedBy: c.ctx.userId })
      return { ok: true }
    },

    saveVersion: async (c) => {
      const workflowId = str(c.params, 'workflowId')
      const graph = parseGraph(c.params)
      const p = c.params as {
        changeNote?: string
        aiSummary?: WfChangeSummary
      }
      // Capture the outgoing latest version's graph as the "previous" for a
      // possible background summary — before saveVersion bumps the latest
      // pointer.
      const owner = await getWorkflow(c.db, workflowId)
      if (!owner) {
        throw new Error('Workflow not found')
      }
      const previousGraph =
        (owner.currentVersion?.graph as WorkflowGraph) ?? null
      const out = await saveVersion(c.db, {
        workflowId,
        graph,
        changeNote: p.changeNote,
        aiSummaryShort: p.aiSummary?.short,
        aiSummaryLong: p.aiSummary?.long,
        publishedBy: c.ctx.userId,
      })
      // Published before the summary was ready: generate + persist it in the
      // background so the response returns immediately. Only when the host
      // wired a scheduler — otherwise the summary stays null until a later
      // explicit summarizeChanges call. `env` is resolved now, inside the
      // request scope, so the deferred work doesn't depend on request-bound
      // context that may be gone once the response is sent.
      if (!p.aiSummary && opts.waitUntil) {
        const env = await c.env()
        opts.waitUntil(
          (async () => {
            try {
              const summary = await computeChangeSummary(opts, {
                previousGraph,
                nextGraph: graph,
                ctx: c.ctx,
                req: c.req,
                env,
              })
              await setVersionAiSummary(c.db, {
                versionId: out.versionId,
                short: summary.short,
                long: summary.long,
              })
            } catch (err) {
              console.error('[wf] background summary failed:', err)
            }
          })(),
        )
      }
      return out
    },

    summarizeChanges: async (c) => {
      const workflowId = str(c.params, 'workflowId')
      const nextGraph = parseGraph(c.params)
      const owner = await getWorkflow(c.db, workflowId)
      if (!owner) {
        throw new Error('Workflow not found')
      }
      const previousGraph =
        (owner.currentVersion?.graph as WorkflowGraph) ?? null
      return await computeChangeSummary(opts, {
        previousGraph,
        nextGraph,
        ctx: c.ctx,
        req: c.req,
        env: await c.env(),
      })
    },

    updateWorkflow: async (c) => {
      const workflowId = str(c.params, 'workflowId')
      const p = c.params as {
        name?: string
        description?: string | null
        archived?: boolean
      }
      await requireExists(c.db, workflowId)
      await updateWorkflow(c.db, {
        workflowId,
        name: p.name,
        description: p.description,
        archived: p.archived,
      })
      return { ok: true }
    },

    discardDraft: async (c) => {
      const workflowId = str(c.params, 'workflowId')
      await requireExists(c.db, workflowId)
      await discardDraft(c.db, { workflowId })
      return { ok: true }
    },

    listVersions: async (c) => {
      const workflowId = str(c.params, 'workflowId')
      await requireExists(c.db, workflowId)
      const rows = await listVersions(c.db, workflowId)
      return rows.map((v) => ({
        id: v.id,
        versionNumber: v.versionNumber,
        changeNote: v.changeNote,
        aiSummaryShort: v.aiSummaryShort,
        aiSummaryLong: v.aiSummaryLong,
        createdAt: v.createdAt.getTime(),
        publishedAt: toEpoch(v.publishedAt),
      }))
    },

    getVersion: async (c) => {
      const versionId = str(c.params, 'versionId')
      const v = await getVersionGraph(c.db, versionId)
      if (!v) {
        return null
      }
      return {
        graph: v.graph as WorkflowGraph,
        versionNumber: v.versionNumber,
      }
    },

    listRuns: async (c) => {
      const p = c.params as {
        workflowVersionId?: string
        workflowId?: string
        triggerKind?: string
        status?: string
        search?: string
        since?: number
        until?: number
        limit?: number
        offset?: number
      }
      const result = await listRuns(c.db, {
        workflowVersionId: p.workflowVersionId,
        workflowId: p.workflowId,
        triggerKind: p.triggerKind,
        status: p.status,
        search: p.search?.trim() || undefined,
        since: typeof p.since === 'number' ? new Date(p.since) : undefined,
        until: typeof p.until === 'number' ? new Date(p.until) : undefined,
        limit: p.limit,
        offset: p.offset,
      })
      return {
        runs: result.rows.map((r) => runSummary(r, opts.sentryTraceUrl)),
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      }
    },

    listRunTriggerKinds: async (c) => await listRunTriggerKinds(c.db),

    getRun: async (c) => {
      const runId = str(c.params, 'runId')
      const result = await getRun(c.db, runId)
      if (!result) {
        return null
      }
      const steps: WfRunStepDTO[] = result.steps.map((s) => ({
        nodeId: s.nodeId,
        nodeKind: s.nodeKind,
        parentNodeId: s.parentNodeId ?? null,
        itemIndex: s.itemIndex,
        sequence: s.sequence,
        status: s.status,
        input: s.input,
        output: s.output,
        branchResult: s.branchResult,
        meta: s.meta,
        error: s.error,
        startedAt: toEpoch(s.startedAt),
        finishedAt: toEpoch(s.finishedAt),
        costUsd: s.costUsd ?? null,
      }))
      // `getRunLogs` already returns exactly the wire shape (WfRunLogRow is
      // field-identical to WfRunLogDTO), so this is a direct assignment, not a
      // remap — the annotation makes any future field drift a compile error.
      const logs: WfRunLogDTO[] = result.logs
      const detail: WfRunDetail = {
        run: {
          ...runSummary(
            {
              ...result.run,
              workflowId: result.workflowId ?? '',
              workflowName: result.workflowName ?? '(unknown workflow)',
              versionNumber: result.versionNumber ?? 0,
              totalTokens: result.totalTokens,
              costUsd: result.costUsd,
            },
            opts.sentryTraceUrl,
          ),
          output: result.run.output,
        },
        steps,
        logs,
        graph: (result.graph as WorkflowGraph | null) ?? null,
        versionNumber: result.versionNumber,
      }
      return detail
    },

    retryRun: async (c) => {
      const retryRun = requireHook(
        opts.retryRun,
        'Retry is not configured for this host.',
      )
      const runId = str(c.params, 'runId')
      const mode: RetryRunMode =
        (c.params as { mode?: string }).mode === 'resume' ? 'resume' : 'restart'
      const result = await getRun(c.db, runId)
      if (!result) {
        throw new Error('Run not found.')
      }
      // Reconstruct the trigger input from the recorded trigger step — the
      // run row doesn't persist it. The trigger "executes" instantly with
      // its output set to the validated trigger input (see executor.ts).
      const triggerStep = result.steps.find((s) => s.nodeKind === 'trigger')
      const latestVersionId = result.workflowId
        ? await getLatestVersionId(c.db, result.workflowId)
        : null
      return await retryRun({
        mode,
        source: {
          runId,
          workflowId: result.workflowId ?? '',
          originalVersionId: result.run.workflowVersionId,
          latestVersionId,
          triggerKind: result.run.triggerKind,
          triggerInput: triggerStep?.output ?? triggerStep?.input ?? {},
          subjectId: result.run.subjectId,
          correlationId: result.run.correlationId,
        },
        ctx: c.ctx,
        req: c.req,
      })
    },

    listAgents: async (c) => {
      const rows = await listAgents(c.db)
      const byAgent = await listWorkflowsReferencingAllAgents(c.db)
      return rows.map((r) => agentSummary(r, r.config, byAgent.get(r.id) ?? []))
    },

    getAgent: async (c) => {
      const agentId = str(c.params, 'agentId')
      const result = await getAgent(c.db, agentId)
      if (!result) {
        return null
      }
      const detail: WfAgentDetail = {
        agent: agentSummary(result.agent, result.currentVersion?.config),
        draft: result.draft
          ? { config: agentConfigSchema.parse(result.draft.config) }
          : null,
        currentVersion: result.currentVersion
          ? {
              id: result.currentVersion.id,
              versionNumber: result.currentVersion.versionNumber,
              config: agentConfigSchema.parse(result.currentVersion.config),
            }
          : null,
      }
      return detail
    },

    createAgent: async (c) => {
      const name = str(c.params, 'name')
      const config = parseAgentConfig(c.params)
      const p = c.params as {
        description?: string
        icon?: string
        color?: string
      }
      return await createAgent(c.db, {
        name,
        description: p.description,
        icon: p.icon,
        color: p.color,
        createdBy: c.ctx.userId,
        config,
      })
    },

    updateAgentDraft: async (c) => {
      const agentId = str(c.params, 'agentId')
      const config = parseAgentConfig(c.params)
      await requireAgentExists(c.db, agentId)
      await updateAgentDraft(c.db, {
        agentId,
        config,
        lastEditedBy: c.ctx.userId,
      })
      return { ok: true }
    },

    publishAgent: async (c) => {
      const agentId = str(c.params, 'agentId')
      const config = parseAgentConfig(c.params)
      const changeNote = (c.params as { changeNote?: string }).changeNote
      await requireAgentExists(c.db, agentId)
      return await publishAgent(c.db, {
        agentId,
        config,
        changeNote,
        publishedBy: c.ctx.userId,
      })
    },

    listAgentVersions: async (c) => {
      const agentId = str(c.params, 'agentId')
      await requireAgentExists(c.db, agentId)
      const rows = await listAgentVersions(c.db, agentId)
      return rows.map((v) => ({
        id: v.id,
        versionNumber: v.versionNumber,
        changeNote: v.changeNote,
        createdAt: v.createdAt.getTime(),
        publishedAt: toEpoch(v.publishedAt),
      }))
    },

    updateAgentMeta: async (c) => {
      const agentId = str(c.params, 'agentId')
      await requireAgentExists(c.db, agentId)
      const p = c.params as {
        name?: string
        description?: string
        icon?: string
        color?: string
      }
      await updateAgentMeta(c.db, {
        agentId,
        name: p.name,
        description: p.description,
        icon: p.icon,
        color: p.color,
      })
      return { ok: true }
    },

    discardAgentDraft: async (c) => {
      const agentId = str(c.params, 'agentId')
      await requireAgentExists(c.db, agentId)
      await discardAgentDraft(c.db, { agentId })
      return { ok: true }
    },

    countAgentReferences: async (c) => {
      const agentId = str(c.params, 'agentId')
      await requireAgentExists(c.db, agentId)
      const workflows = await countWorkflowsReferencingAgent(c.db, { agentId })
      return { workflows }
    },

    listAgentReferences: async (c) => {
      const agentId = str(c.params, 'agentId')
      await requireAgentExists(c.db, agentId)
      const workflows = await listWorkflowsReferencingAgent(c.db, { agentId })
      return { workflows }
    },

    archiveAgent: async (c) => {
      const agentId = str(c.params, 'agentId')
      await requireAgentExists(c.db, agentId)
      await archiveAgent(c.db, { agentId })
      return { ok: true }
    },

    runAgentPreview: async (c) => {
      const runAgentPreview = requireHook(
        opts.runAgentPreview,
        'The agent playground is not configured on this host.',
      )
      const config = parseAgentConfig(c.params)
      const p = c.params as { input?: unknown; promptVariables?: unknown }
      const input = typeof p.input === 'string' ? p.input : ''
      const promptVariables = parseStringRecord(p.promptVariables)
      if (!input && Object.keys(promptVariables).length === 0) {
        throw new Error('Provide a test input or fill in the prompt variables.')
      }
      return await runAgentPreview({
        config,
        input,
        promptVariables,
        ctx: c.ctx,
        req: c.req,
      })
    },

    runToolPreview: async (c) => {
      const runToolPreview = requireHook(
        opts.runToolPreview,
        'The tool playground is not configured on this host.',
      )
      const toolId = str(c.params, 'toolId')
      // Guard against calling an unregistered tool before we build real deps.
      if (!opts.config.toolRegistry.has(toolId)) {
        throw new Error(`Tool '${toolId}' is not registered.`)
      }
      const rawArgs = (c.params as { args?: unknown }).args
      const args =
        rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {}
      const context = parseStringRecord(
        (c.params as { context?: unknown }).context,
      )
      return await runToolPreview({
        toolId,
        args,
        context,
        ctx: c.ctx,
        req: c.req,
      })
    },

    listEvalSets: async (c) => {
      const includeArchived = (c.params as { includeArchived?: boolean })
        .includeArchived
      const rows = await listEvalSets(c.db, { includeArchived })
      return rows.map((r) => evalSetSummary(r, Number(r.rowCount)))
    },

    getEvalSet: async (c) => {
      const setId = str(c.params, 'setId')
      const result = await getEvalSet(c.db, setId)
      if (!result) {
        return null
      }
      const rows: WfEvalRowDTO[] = result.rows
      return {
        set: evalSetSummary(result.set, rows.length),
        rows,
      }
    },

    createEvalSet: async (c) => {
      const name = str(c.params, 'name')
      const targetId = str(c.params, 'targetId')
      const triggerKind = str(c.params, 'triggerKind')
      const p = c.params as {
        description?: string
        targetKind?: WfEvalTargetKind
        targetVersion?: number | null
      }
      const targetKind: WfEvalTargetKind =
        p.targetKind === 'workflow' ? 'workflow' : 'agent'
      const setId = await createEvalSet(c.db, {
        name,
        description: p.description,
        targetKind,
        targetId,
        targetVersion: p.targetVersion ?? null,
        triggerKind,
        createdBy: c.ctx.userId,
      })
      return { setId }
    },

    updateEvalSet: async (c) => {
      const setId = str(c.params, 'setId')
      const p = c.params as {
        name?: string
        description?: string | null
        targetKind?: WfEvalTargetKind
        targetId?: string
        targetVersion?: number | null
        triggerKind?: string
        archived?: boolean
      }
      await updateEvalSet(c.db, {
        setId,
        name: p.name,
        description: p.description,
        targetKind: p.targetKind,
        targetId: p.targetId,
        targetVersion: p.targetVersion,
        triggerKind: p.triggerKind,
        archived: p.archived,
      })
      return { ok: true }
    },

    deleteEvalSet: async (c) => {
      const setId = str(c.params, 'setId')
      await deleteEvalSet(c.db, setId)
      return { ok: true }
    },

    upsertEvalRow: async (c) => {
      const setId = str(c.params, 'setId')
      const name = str(c.params, 'name')
      const p = c.params as {
        id?: string
        description?: string | null
        initialCondition?: WfEvalRowDTO['initialCondition']
        fixtures?: WfEvalRowDTO['fixtures']
        checks?: WfEvalRowDTO['checks']
        sortOrder?: number
      }
      // The JSON payloads are validated inside `upsertEvalRow` (zod).
      const rowId = await upsertEvalRow(c.db, {
        id: p.id,
        setId,
        name,
        description: p.description,
        initialCondition: p.initialCondition,
        fixtures: p.fixtures,
        checks: p.checks,
        sortOrder: p.sortOrder,
      })
      return { rowId }
    },

    deleteEvalRow: async (c) => {
      const rowId = str(c.params, 'rowId')
      await deleteEvalRow(c.db, rowId)
      return { ok: true }
    },

    createEvalRun: async (c) => {
      const p = c.params as { setIds?: unknown; total?: number }
      const setIds = Array.isArray(p.setIds)
        ? p.setIds.filter((s): s is string => typeof s === 'string')
        : []
      if (setIds.length === 0) {
        throw new Error('createEvalRun requires at least one set id.')
      }
      const evalRunId = await createEvalRun(c.db, {
        setIds,
        total: p.total,
        createdBy: c.ctx.userId,
      })
      return { evalRunId }
    },

    startEvalRun: async (c) => {
      const startEvalRun = requireHook(
        opts.startEvalRun,
        'Eval runs are not configured for this host.',
      )
      const evalRunId = str(c.params, 'evalRunId')
      const rowId = str(c.params, 'rowId')
      const run = await getEvalRun(c.db, evalRunId)
      if (!run) {
        throw new Error('Eval run not found.')
      }
      const found = await getEvalRow(c.db, rowId)
      if (!found) {
        throw new Error('Eval sample not found.')
      }
      const { row, set } = found
      // Resolve the target to a concrete version (agent → hidden wrapper) and
      // the trigger kind to start under, before handing the host the run.
      const resolved = await resolveEvalTarget(
        c.db,
        { kind: set.targetKind, id: set.targetId },
        set.triggerKind,
        { createdBy: c.ctx.userId },
      )
      const started = await startEvalRun({
        evalRunId,
        rowId,
        target: { kind: set.targetKind, id: set.targetId },
        workflowVersionId: resolved.workflowVersionId,
        triggerKind: resolved.triggerKind,
        triggerInput: row.initialCondition.triggerInput ?? {},
        promptVariables: row.initialCondition.promptVariables ?? {},
        fixtures: row.fixtures,
        ctx: c.ctx,
        req: c.req,
      })
      // Flip the umbrella run to running on its first started row.
      if (run.run.status === 'queued') {
        await updateEvalRun(c.db, {
          evalRunId,
          status: 'running',
          startedAt: new Date(),
        })
      }
      return started
    },

    gradeEvalResult: async (c) => {
      const evalRunId = str(c.params, 'evalRunId')
      const rowId = str(c.params, 'rowId')
      const wfRunId = str(c.params, 'wfRunId')
      const found = await getEvalRow(c.db, rowId)
      if (!found) {
        throw new Error('Eval sample not found.')
      }
      const runResult = await getRun(c.db, wfRunId)
      if (!runResult) {
        throw new Error('Run not found.')
      }
      const steps = toGradeSteps(runResult.steps)
      const env = await c.env()
      // Judge checks resolve their model through the host's live seam.
      const getModel: GradeModelFactory = (modelId) =>
        opts.config.getModel(modelId, { triggerKind: 'eval', env })
      const defaultJudgeModelId =
        opts.evalJudgeModelId ?? (await opts.config.listModels({ env }))[0]?.id
      const graded = await gradeRow({
        checks: found.row.checks,
        steps,
        output: runResult.run.output,
        getModel,
        defaultJudgeModelId,
      })
      // Freeze the Sample + Goal target this result was graded against, so
      // the report reproduces it exactly even after the definitions change.
      // The concrete agent version that ran stays reachable via wfRunId →
      // wf_run.manifest, so it isn't duplicated in the snapshot.
      const snapshot = buildEvalSnapshot(found.row, found.set)
      const snapshotHash = await hashEvalSnapshot(snapshot)
      const resultId = await insertEvalResult(c.db, {
        evalRunId,
        rowId,
        wfRunId,
        status: graded.status,
        score: graded.score,
        checkResults: graded.checkResults,
        snapshot,
        snapshotHash,
      })
      // Reuse the shared mapper so this result's shape can't drift from the one
      // `getEvalRun` returns. `createdAt` is the response's best-effort now (the
      // row isn't re-read); the mapper takes a Date and emits epoch ms.
      return evalResultDTO({
        id: resultId,
        evalRunId,
        rowId,
        wfRunId,
        status: graded.status,
        score: graded.score,
        checkResults: graded.checkResults,
        snapshot,
        snapshotHash,
        createdAt: new Date(),
      })
    },

    finalizeEvalRun: async (c) => {
      const evalRunId = str(c.params, 'evalRunId')
      const found = await getEvalRun(c.db, evalRunId)
      if (!found) {
        throw new Error('Eval run not found.')
      }
      const summary = rollup(
        found.results.map((r) => ({ status: r.status, score: r.score })),
      )
      await updateEvalRun(c.db, {
        evalRunId,
        status: 'completed',
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        score: summary.meanScore,
        finishedAt: new Date(),
      })
      const updated = await getEvalRun(c.db, evalRunId)
      return evalRunSummary(updated?.run ?? found.run)
    },

    listEvalRuns: async (c) => {
      const limit = (c.params as { limit?: number }).limit
      const rows = await listEvalRuns(c.db, { limit })
      return rows.map(evalRunSummary)
    },

    getEvalRun: async (c) => {
      const evalRunId = str(c.params, 'evalRunId')
      const result = await getEvalRun(c.db, evalRunId)
      if (!result) {
        return null
      }
      return {
        run: evalRunSummary(result.run),
        results: result.results.map(evalResultDTO),
      }
    },
  }
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
      // Surface the failure in the server log — otherwise a 500 from any
      // handler is invisible (the client only sees a generic error string).
      console.error(`[wf] ${method} failed:`, err)
      return json({ error: errorMessage(err) }, 500)
    }
  }
}

// Guard a mutation against a missing target before writing.
async function requireExists(db: WfDb, workflowId: string): Promise<void> {
  const result = await getWorkflow(db, workflowId)
  if (!result) {
    throw new Error('Workflow not found')
  }
}

async function requireAgentExists(db: WfDb, agentId: string): Promise<void> {
  const result = await getAgent(db, agentId)
  if (!result) {
    throw new Error('Agent not found')
  }
}
