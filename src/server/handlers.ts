import { z } from 'zod'

import type { WfSdkConfig } from '../engine/config'
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
  getRun,
  getVersionGraph,
  getWorkflow,
  hashEvalSnapshot,
  insertEvalResult,
  listAgents,
  listAgentVersions,
  listEvalRuns,
  listEvalSets,
  listRuns,
  listRunTriggerKinds,
  listToolInvocations,
  listVersions,
  listWorkflows,
  publishAgent,
  saveVersion,
  setVersionAiSummary,
  updateAgentDraft,
  updateAgentMeta,
  updateDraft,
  updateEvalRun,
  updateEvalSet,
  updateWorkflow,
  upsertEvalRow,
} from '../storage/data'

import type {
  AgentPreviewResult,
  EvalRowSnapshot,
  JsonSchema,
  RetryRunMode,
  WfAgentDetail,
  WfAgentSummary,
  WfChangeSummary,
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
    'getModel' | 'listModels' | 'listProviders' | 'toolRegistry' | 'triggers'
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

function str(params: unknown, key: string): string {
  const v = (params as Record<string, unknown>)[key]
  if (typeof v !== 'string' || !v) {
    throw new Error(`Missing '${key}' parameter.`)
  }
  return v
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

export function createWfSdkHandlers<TDeps>(
  opts: CreateWfSdkHandlersOptions<TDeps>,
): (req: Request) => Promise<Response> {
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
    const params = envelope.params ?? {}
    if (!method) {
      return json({ error: 'Missing method' }, 400)
    }

    try {
      const ctx = await opts.resolveContext(req)
      const db = await opts.resolveDb(req)

      switch (method) {
        case 'listModels': {
          const env = opts.resolveEnv ? await opts.resolveEnv(req) : undefined
          return json(await opts.config.listModels({ env }))
        }

        case 'listProviders': {
          const env = opts.resolveEnv ? await opts.resolveEnv(req) : undefined
          return json(await opts.config.listProviders({ env }))
        }

        case 'listTools':
          return json(
            [...opts.config.toolRegistry].map(([id, entry]) => ({
              id,
              name: entry.name,
              description: entry.description,
              icon: entry.icon,
              kind: entry.kind,
              inputSchema: toJsonSchema(entry.inputSchema, 'input'),
              outputSchema: toJsonSchema(entry.outputSchema, 'output'),
            })),
          )

        case 'listToolInvocations': {
          const toolId = str(params, 'toolId')
          const limit = (params as { limit?: number }).limit
          const rows = await listToolInvocations(db, {
            toolId,
            limit,
          })
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
          return json(invocations)
        }

        case 'listToolContextFields':
          return json(opts.toolContextFields ?? [])

        case 'listTriggerEvents':
          return json(describeTriggerEvents(opts.config.triggers))

        case 'listWorkflows': {
          const rows = await listWorkflows(db)
          return json(rows.map(workflowSummary))
        }

        case 'getWorkflow': {
          const workflowId = str(params, 'workflowId')
          const result = await getWorkflow(db, workflowId)
          if (!result) {
            return json(null)
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
          return json(detail)
        }

        case 'createWorkflow': {
          const name = str(params, 'name')
          const graph = parseGraph(params)
          const description = (params as { description?: string }).description
          const out = await createWorkflow(db, {
            name,
            description,
            createdBy: ctx.userId,
            graph,
          })
          return json(out)
        }

        case 'updateDraft': {
          const workflowId = str(params, 'workflowId')
          const graph = parseGraph(params)
          await requireExists(db, workflowId)
          await updateDraft(db, { workflowId, graph, lastEditedBy: ctx.userId })
          return json({ ok: true })
        }

        case 'saveVersion': {
          const workflowId = str(params, 'workflowId')
          const graph = parseGraph(params)
          const p = params as {
            changeNote?: string
            aiSummary?: WfChangeSummary
          }
          // Capture the outgoing latest version's graph as the "previous" for a
          // possible background summary — before saveVersion bumps the latest
          // pointer.
          const owner = await getWorkflow(db, workflowId)
          if (!owner) {
            throw new Error('Workflow not found')
          }
          const previousGraph =
            (owner.currentVersion?.graph as WorkflowGraph) ?? null
          const out = await saveVersion(db, {
            workflowId,
            graph,
            changeNote: p.changeNote,
            aiSummaryShort: p.aiSummary?.short,
            aiSummaryLong: p.aiSummary?.long,
            publishedBy: ctx.userId,
          })
          // Published before the summary was ready: generate + persist it in the
          // background so the response returns immediately. Only when the host
          // wired a scheduler — otherwise the summary stays null until a later
          // explicit summarizeChanges call. `env` is resolved now, inside the
          // request scope, so the deferred work doesn't depend on request-bound
          // context that may be gone once the response is sent.
          if (!p.aiSummary && opts.waitUntil) {
            const env = opts.resolveEnv ? await opts.resolveEnv(req) : undefined
            opts.waitUntil(
              (async () => {
                try {
                  const summary = await computeChangeSummary(opts, {
                    previousGraph,
                    nextGraph: graph,
                    ctx,
                    req,
                    env,
                  })
                  await setVersionAiSummary(db, {
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
          return json(out)
        }

        case 'summarizeChanges': {
          const workflowId = str(params, 'workflowId')
          const nextGraph = parseGraph(params)
          const owner = await getWorkflow(db, workflowId)
          if (!owner) {
            throw new Error('Workflow not found')
          }
          const previousGraph =
            (owner.currentVersion?.graph as WorkflowGraph) ?? null
          const env = opts.resolveEnv ? await opts.resolveEnv(req) : undefined
          const summary = await computeChangeSummary(opts, {
            previousGraph,
            nextGraph,
            ctx,
            req,
            env,
          })
          return json(summary)
        }

        case 'updateWorkflow': {
          const workflowId = str(params, 'workflowId')
          const p = params as {
            name?: string
            description?: string | null
            archived?: boolean
          }
          await requireExists(db, workflowId)
          await updateWorkflow(db, {
            workflowId,
            name: p.name,
            description: p.description,
            archived: p.archived,
          })
          return json({ ok: true })
        }

        case 'discardDraft': {
          const workflowId = str(params, 'workflowId')
          await requireExists(db, workflowId)
          await discardDraft(db, { workflowId })
          return json({ ok: true })
        }

        case 'listVersions': {
          const workflowId = str(params, 'workflowId')
          await requireExists(db, workflowId)
          const rows = await listVersions(db, workflowId)
          return json(
            rows.map((v) => ({
              id: v.id,
              versionNumber: v.versionNumber,
              changeNote: v.changeNote,
              aiSummaryShort: v.aiSummaryShort,
              aiSummaryLong: v.aiSummaryLong,
              createdAt: v.createdAt.getTime(),
              publishedAt: toEpoch(v.publishedAt),
            })),
          )
        }

        case 'getVersion': {
          const versionId = str(params, 'versionId')
          const v = await getVersionGraph(db, versionId)
          if (!v) {
            return json(null)
          }
          return json({
            graph: v.graph as WorkflowGraph,
            versionNumber: v.versionNumber,
          })
        }

        case 'listRuns': {
          const p = params as {
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
          const result = await listRuns(db, {
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
          return json({
            runs: result.rows.map((r) => runSummary(r, opts.sentryTraceUrl)),
            total: result.total,
            limit: result.limit,
            offset: result.offset,
          })
        }

        case 'listRunTriggerKinds': {
          const kinds = await listRunTriggerKinds(db)
          return json(kinds)
        }

        case 'getRun': {
          const runId = str(params, 'runId')
          const result = await getRun(db, runId)
          if (!result) {
            return json(null)
          }
          const steps: WfRunStepDTO[] = result.steps.map((s) => ({
            nodeId: s.nodeId,
            nodeKind: s.nodeKind,
            sequence: s.sequence,
            status: s.status,
            input: s.input,
            output: s.output,
            branchResult: s.branchResult,
            meta: s.meta,
            error: s.error,
          }))
          const logs: WfRunLogDTO[] = result.logs.map((l) => ({
            nodeId: l.nodeId,
            nodeKind: l.nodeKind,
            sequence: l.sequence,
            level: l.level,
            message: l.message,
            meta: l.meta,
            ts: l.ts,
          }))
          const detail: WfRunDetail = {
            run: {
              ...runSummary(
                {
                  ...result.run,
                  workflowId: result.workflowId ?? '',
                  workflowName: result.workflowName ?? '(unknown workflow)',
                  versionNumber: result.versionNumber ?? 0,
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
          return json(detail)
        }

        case 'retryRun': {
          if (!opts.retryRun) {
            throw new Error('Retry is not configured for this host.')
          }
          const runId = str(params, 'runId')
          const mode: RetryRunMode =
            (params as { mode?: string }).mode === 'resume'
              ? 'resume'
              : 'restart'
          const result = await getRun(db, runId)
          if (!result) {
            throw new Error('Run not found.')
          }
          // Reconstruct the trigger input from the recorded trigger step — the
          // run row doesn't persist it. The trigger "executes" instantly with
          // its output set to the validated trigger input (see executor.ts).
          const triggerStep = result.steps.find((s) => s.nodeKind === 'trigger')
          const latestVersionId = result.workflowId
            ? await getLatestVersionId(db, result.workflowId)
            : null
          const started = await opts.retryRun({
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
            ctx,
            req,
          })
          return json(started)
        }

        case 'listAgents': {
          const rows = await listAgents(db)
          return json(rows.map((r) => agentSummary(r, r.config)))
        }

        case 'getAgent': {
          const agentId = str(params, 'agentId')
          const result = await getAgent(db, agentId)
          if (!result) {
            return json(null)
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
          return json(detail)
        }

        case 'createAgent': {
          const name = str(params, 'name')
          const config = parseAgentConfig(params)
          const p = params as {
            description?: string
            icon?: string
            color?: string
          }
          const out = await createAgent(db, {
            name,
            description: p.description,
            icon: p.icon,
            color: p.color,
            createdBy: ctx.userId,
            config,
          })
          return json(out)
        }

        case 'updateAgentDraft': {
          const agentId = str(params, 'agentId')
          const config = parseAgentConfig(params)
          await requireAgentExists(db, agentId)
          await updateAgentDraft(db, {
            agentId,
            config,
            lastEditedBy: ctx.userId,
          })
          return json({ ok: true })
        }

        case 'publishAgent': {
          const agentId = str(params, 'agentId')
          const config = parseAgentConfig(params)
          const changeNote = (params as { changeNote?: string }).changeNote
          await requireAgentExists(db, agentId)
          const out = await publishAgent(db, {
            agentId,
            config,
            changeNote,
            publishedBy: ctx.userId,
          })
          return json(out)
        }

        case 'listAgentVersions': {
          const agentId = str(params, 'agentId')
          await requireAgentExists(db, agentId)
          const rows = await listAgentVersions(db, agentId)
          return json(
            rows.map((v) => ({
              id: v.id,
              versionNumber: v.versionNumber,
              changeNote: v.changeNote,
              createdAt: v.createdAt.getTime(),
              publishedAt: toEpoch(v.publishedAt),
            })),
          )
        }

        case 'updateAgentMeta': {
          const agentId = str(params, 'agentId')
          await requireAgentExists(db, agentId)
          const p = params as {
            name?: string
            description?: string
            icon?: string
            color?: string
          }
          await updateAgentMeta(db, {
            agentId,
            name: p.name,
            description: p.description,
            icon: p.icon,
            color: p.color,
          })
          return json({ ok: true })
        }

        case 'discardAgentDraft': {
          const agentId = str(params, 'agentId')
          await requireAgentExists(db, agentId)
          await discardAgentDraft(db, { agentId })
          return json({ ok: true })
        }

        case 'countAgentReferences': {
          const agentId = str(params, 'agentId')
          await requireAgentExists(db, agentId)
          const workflows = await countWorkflowsReferencingAgent(db, {
            agentId,
          })
          return json({ workflows })
        }

        case 'runAgentPreview': {
          if (!opts.runAgentPreview) {
            throw new Error(
              'The agent playground is not configured on this host.',
            )
          }
          const config = parseAgentConfig(params)
          const p = params as { input?: unknown; promptVariables?: unknown }
          const input = typeof p.input === 'string' ? p.input : ''
          const promptVariables = parseStringRecord(p.promptVariables)
          if (!input && Object.keys(promptVariables).length === 0) {
            throw new Error(
              'Provide a test input or fill in the prompt variables.',
            )
          }
          const result = await opts.runAgentPreview({
            config,
            input,
            promptVariables,
            ctx,
            req,
          })
          return json(result)
        }

        case 'runToolPreview': {
          if (!opts.runToolPreview) {
            throw new Error(
              'The tool playground is not configured on this host.',
            )
          }
          const toolId = str(params, 'toolId')
          // Guard against calling an unregistered tool before we build real deps.
          if (!opts.config.toolRegistry.has(toolId)) {
            throw new Error(`Tool '${toolId}' is not registered.`)
          }
          const rawArgs = (params as { args?: unknown }).args
          const args =
            rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
              ? (rawArgs as Record<string, unknown>)
              : {}
          const context = parseStringRecord(
            (params as { context?: unknown }).context,
          )
          const result = await opts.runToolPreview({
            toolId,
            args,
            context,
            ctx,
            req,
          })
          return json(result)
        }

        case 'listEvalSets': {
          const includeArchived = (params as { includeArchived?: boolean })
            .includeArchived
          const rows = await listEvalSets(db, { includeArchived })
          return json(rows.map((r) => evalSetSummary(r, Number(r.rowCount))))
        }

        case 'getEvalSet': {
          const setId = str(params, 'setId')
          const result = await getEvalSet(db, setId)
          if (!result) {
            return json(null)
          }
          const rows: WfEvalRowDTO[] = result.rows
          return json({
            set: evalSetSummary(result.set, rows.length),
            rows,
          })
        }

        case 'createEvalSet': {
          const name = str(params, 'name')
          const targetId = str(params, 'targetId')
          const triggerKind = str(params, 'triggerKind')
          const p = params as {
            description?: string
            targetKind?: WfEvalTargetKind
            targetVersion?: number | null
          }
          const targetKind: WfEvalTargetKind =
            p.targetKind === 'workflow' ? 'workflow' : 'agent'
          const setId = await createEvalSet(db, {
            name,
            description: p.description,
            targetKind,
            targetId,
            targetVersion: p.targetVersion ?? null,
            triggerKind,
            createdBy: ctx.userId,
          })
          return json({ setId })
        }

        case 'updateEvalSet': {
          const setId = str(params, 'setId')
          const p = params as {
            name?: string
            description?: string | null
            targetKind?: WfEvalTargetKind
            targetId?: string
            targetVersion?: number | null
            triggerKind?: string
            archived?: boolean
          }
          await updateEvalSet(db, {
            setId,
            name: p.name,
            description: p.description,
            targetKind: p.targetKind,
            targetId: p.targetId,
            targetVersion: p.targetVersion,
            triggerKind: p.triggerKind,
            archived: p.archived,
          })
          return json({ ok: true })
        }

        case 'deleteEvalSet': {
          const setId = str(params, 'setId')
          await deleteEvalSet(db, setId)
          return json({ ok: true })
        }

        case 'upsertEvalRow': {
          const setId = str(params, 'setId')
          const name = str(params, 'name')
          const p = params as {
            id?: string
            description?: string | null
            initialCondition?: WfEvalRowDTO['initialCondition']
            fixtures?: WfEvalRowDTO['fixtures']
            checks?: WfEvalRowDTO['checks']
            sortOrder?: number
          }
          // The JSON payloads are validated inside `upsertEvalRow` (zod).
          const rowId = await upsertEvalRow(db, {
            id: p.id,
            setId,
            name,
            description: p.description,
            initialCondition: p.initialCondition,
            fixtures: p.fixtures,
            checks: p.checks,
            sortOrder: p.sortOrder,
          })
          return json({ rowId })
        }

        case 'deleteEvalRow': {
          const rowId = str(params, 'rowId')
          await deleteEvalRow(db, rowId)
          return json({ ok: true })
        }

        case 'createEvalRun': {
          const p = params as { setIds?: unknown; total?: number }
          const setIds = Array.isArray(p.setIds)
            ? p.setIds.filter((s): s is string => typeof s === 'string')
            : []
          if (setIds.length === 0) {
            throw new Error('createEvalRun requires at least one set id.')
          }
          const evalRunId = await createEvalRun(db, {
            setIds,
            total: p.total,
            createdBy: ctx.userId,
          })
          return json({ evalRunId })
        }

        case 'startEvalRun': {
          if (!opts.startEvalRun) {
            throw new Error('Eval runs are not configured for this host.')
          }
          const evalRunId = str(params, 'evalRunId')
          const rowId = str(params, 'rowId')
          const run = await getEvalRun(db, evalRunId)
          if (!run) {
            throw new Error('Eval run not found.')
          }
          const found = await getEvalRow(db, rowId)
          if (!found) {
            throw new Error('Eval sample not found.')
          }
          const { row, set } = found
          // Resolve the target to a concrete version (agent → hidden wrapper) and
          // the trigger kind to start under, before handing the host the run.
          const resolved = await resolveEvalTarget(
            db,
            { kind: set.targetKind, id: set.targetId },
            set.triggerKind,
            { createdBy: ctx.userId },
          )
          const started = await opts.startEvalRun({
            evalRunId,
            rowId,
            target: { kind: set.targetKind, id: set.targetId },
            workflowVersionId: resolved.workflowVersionId,
            triggerKind: resolved.triggerKind,
            triggerInput: row.initialCondition.triggerInput ?? {},
            promptVariables: row.initialCondition.promptVariables ?? {},
            fixtures: row.fixtures,
            ctx,
            req,
          })
          // Flip the umbrella run to running on its first started row.
          if (run.run.status === 'queued') {
            await updateEvalRun(db, {
              evalRunId,
              status: 'running',
              startedAt: new Date(),
            })
          }
          return json(started)
        }

        case 'gradeEvalResult': {
          const evalRunId = str(params, 'evalRunId')
          const rowId = str(params, 'rowId')
          const wfRunId = str(params, 'wfRunId')
          const found = await getEvalRow(db, rowId)
          if (!found) {
            throw new Error('Eval sample not found.')
          }
          const runResult = await getRun(db, wfRunId)
          if (!runResult) {
            throw new Error('Run not found.')
          }
          const steps: GradeStep[] = runResult.steps.map((s) => ({
            nodeId: s.nodeId,
            nodeKind: s.nodeKind,
            input: s.input,
            output: s.output,
            meta: s.meta,
          }))
          const env = opts.resolveEnv ? await opts.resolveEnv(req) : undefined
          // Judge checks resolve their model through the host's live seam.
          const getModel: GradeModelFactory = (modelId) =>
            opts.config.getModel(modelId, { triggerKind: 'eval', env })
          const defaultJudgeModelId =
            opts.evalJudgeModelId ??
            (await opts.config.listModels({ env }))[0]?.id
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
          const resultId = await insertEvalResult(db, {
            evalRunId,
            rowId,
            wfRunId,
            status: graded.status,
            score: graded.score,
            checkResults: graded.checkResults,
            snapshot,
            snapshotHash,
          })
          const dto: WfEvalResultDTO = {
            id: resultId,
            evalRunId,
            rowId,
            wfRunId,
            status: graded.status,
            score: graded.score,
            checkResults: graded.checkResults,
            snapshot,
            snapshotHash,
            createdAt: Date.now(),
          }
          return json(dto)
        }

        case 'finalizeEvalRun': {
          const evalRunId = str(params, 'evalRunId')
          const found = await getEvalRun(db, evalRunId)
          if (!found) {
            throw new Error('Eval run not found.')
          }
          const summary = rollup(
            found.results.map((r) => ({ status: r.status, score: r.score })),
          )
          await updateEvalRun(db, {
            evalRunId,
            status: 'completed',
            total: summary.total,
            passed: summary.passed,
            failed: summary.failed,
            score: summary.meanScore,
            finishedAt: new Date(),
          })
          const updated = await getEvalRun(db, evalRunId)
          return json(evalRunSummary(updated?.run ?? found.run))
        }

        case 'listEvalRuns': {
          const limit = (params as { limit?: number }).limit
          const rows = await listEvalRuns(db, { limit })
          return json(rows.map(evalRunSummary))
        }

        case 'getEvalRun': {
          const evalRunId = str(params, 'evalRunId')
          const result = await getEvalRun(db, evalRunId)
          if (!result) {
            return json(null)
          }
          return json({
            run: evalRunSummary(result.run),
            results: result.results.map(evalResultDTO),
          })
        }

        default:
          return json({ error: `Unknown method '${method}'` }, 400)
      }
    } catch (err) {
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
