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
import type { WfDb } from '../storage/client'
import {
  countWorkflowsReferencingAgent,
  createAgent,
  createWorkflow,
  discardAgentDraft,
  discardDraft,
  getAgent,
  getLatestVersionId,
  getRun,
  getVersionGraph,
  getWorkflow,
  listAgents,
  listAgentVersions,
  listRuns,
  listRunTriggerKinds,
  listVersions,
  listWorkflows,
  publishAgent,
  renameWorkflow,
  saveVersion,
  updateAgentDraft,
  updateAgentMeta,
  updateDraft,
} from '../storage/data'

import type {
  AgentPreviewResult,
  JsonSchema,
  RetryRunMode,
  WfAgentDetail,
  WfAgentSummary,
  WfRunDetail,
  WfRunStepDTO,
  WfRunSummary,
  WfWorkflowDetail,
  WfWorkflowSummary,
} from './protocol'

// Converts a tool's Zod schema to JSON Schema for the wire. Zod v4 ships a
// native converter; anything it can't represent falls back to "no schema"
// rather than failing the whole listing.
function toJsonSchema(schema: z.ZodType | undefined): JsonSchema | undefined {
  if (!schema) return undefined
  try {
    return z.toJSONSchema(schema)
  } catch {
    return undefined
  }
}

// Server-side implementation of the data protocol. The host mounts the returned
// handler at one POST route (e.g. `app/api/wf/route.ts`) and supplies:
//   • resolveDb      — the request-scoped WfDb (from its D1 binding)
//   • resolveContext — the authenticated { tenantId, userId } (never trusted
//                      from the client)
// so the SDK stays auth-free while every query is tenant-scoped.

export type WfServerContext = { tenantId: string; userId?: string }

export type CreateWfSdkHandlersOptions<TDeps> = {
  config: Pick<WfSdkConfig<TDeps>, 'listModels' | 'toolRegistry' | 'triggers'>
  resolveDb: (req: Request) => WfDb | Promise<WfDb>
  resolveContext: (req: Request) => WfServerContext | Promise<WfServerContext>
  /**
   * Optional AI summarizer for the publish dialog — the host supplies the model
   * (per the injection contract). If omitted, a heuristic structural summary is
   * returned instead.
   */
  summarizeChanges?: (input: {
    previousGraph: WorkflowGraph | null
    nextGraph: WorkflowGraph
    ctx: WfServerContext
    req: Request
  }) => Promise<string>
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
}

// Fallback change summary when no host summarizer is provided: a plain count of
// structural deltas between the last published version and the graph to publish.
function heuristicChangeSummary(
  prev: WorkflowGraph | null,
  next: WorkflowGraph,
): string {
  if (!prev) return 'Initial version.'
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
  if (parts.length === 0) return 'No structural changes.'
  const joined = parts.join(', ')
  return joined.charAt(0).toUpperCase() + joined.slice(1) + '.'
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
}): WfWorkflowSummary {
  return {
    id: w.id,
    name: w.name,
    description: w.description,
    createdAt: w.createdAt.getTime(),
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

function runSummary(r: {
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
}): WfRunSummary {
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
    // TEMP diagnostic: shows the method for each POST /api/wf in the dev
    // terminal so we can tell if a call (e.g. summarizeChanges) fires once or
    // loops. Remove once the publish-dialog spinner is resolved.
    console.log('[wf] method:', method)

    try {
      const ctx = await opts.resolveContext(req)
      const db = await opts.resolveDb(req)

      switch (method) {
        case 'listModels':
          return json(opts.config.listModels())

        case 'listTools':
          return json(
            [...opts.config.toolRegistry].map(([id, entry]) => ({
              id,
              name: entry.name,
              description: entry.description,
              icon: entry.icon,
              kind: entry.kind,
              inputSchema: toJsonSchema(entry.inputSchema),
              outputSchema: toJsonSchema(entry.outputSchema),
            })),
          )

        case 'listTriggerEvents':
          return json(describeTriggerEvents(opts.config.triggers))

        case 'listWorkflows': {
          const rows = await listWorkflows(db, ctx.tenantId)
          return json(rows.map(workflowSummary))
        }

        case 'getWorkflow': {
          const workflowId = str(params, 'workflowId')
          const result = await getWorkflow(db, workflowId)
          // Tenant authorization — never leak another tenant's workflow.
          if (!result || result.workflow.tenantId !== ctx.tenantId) {
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
            tenantId: ctx.tenantId,
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
          await requireOwned(db, workflowId, ctx.tenantId)
          await updateDraft(db, { workflowId, graph, lastEditedBy: ctx.userId })
          return json({ ok: true })
        }

        case 'saveVersion': {
          const workflowId = str(params, 'workflowId')
          const graph = parseGraph(params)
          const changeNote = (params as { changeNote?: string }).changeNote
          await requireOwned(db, workflowId, ctx.tenantId)
          const out = await saveVersion(db, {
            workflowId,
            graph,
            changeNote,
            publishedBy: ctx.userId,
          })
          return json(out)
        }

        case 'summarizeChanges': {
          const workflowId = str(params, 'workflowId')
          const nextGraph = parseGraph(params)
          const owner = await getWorkflow(db, workflowId)
          if (!owner || owner.workflow.tenantId !== ctx.tenantId) {
            throw new Error('Workflow not found')
          }
          const previousGraph =
            (owner.currentVersion?.graph as WorkflowGraph) ?? null
          const summary = opts.summarizeChanges
            ? await opts.summarizeChanges({
                previousGraph,
                nextGraph,
                ctx,
                req,
              })
            : heuristicChangeSummary(previousGraph, nextGraph)
          return json({ summary })
        }

        case 'renameWorkflow': {
          const workflowId = str(params, 'workflowId')
          const name = str(params, 'name')
          await requireOwned(db, workflowId, ctx.tenantId)
          await renameWorkflow(db, { workflowId, name })
          return json({ ok: true })
        }

        case 'discardDraft': {
          const workflowId = str(params, 'workflowId')
          await requireOwned(db, workflowId, ctx.tenantId)
          await discardDraft(db, { workflowId })
          return json({ ok: true })
        }

        case 'listVersions': {
          const workflowId = str(params, 'workflowId')
          await requireOwned(db, workflowId, ctx.tenantId)
          const rows = await listVersions(db, workflowId)
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

        case 'getVersion': {
          const versionId = str(params, 'versionId')
          const v = await getVersionGraph(db, versionId)
          if (!v) {
            return json(null)
          }
          // Authorize via the version's owning workflow.
          const owner = await getWorkflow(db, v.workflowId)
          if (!owner || owner.workflow.tenantId !== ctx.tenantId) {
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
            tenantId: ctx.tenantId,
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
            runs: result.rows.map(runSummary),
            total: result.total,
            limit: result.limit,
            offset: result.offset,
          })
        }

        case 'listRunTriggerKinds': {
          const kinds = await listRunTriggerKinds(db, ctx.tenantId)
          return json(kinds)
        }

        case 'getRun': {
          const runId = str(params, 'runId')
          const result = await getRun(db, runId)
          if (!result || result.run.tenantId !== ctx.tenantId) {
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
          const detail: WfRunDetail = {
            run: {
              ...runSummary({
                ...result.run,
                workflowId: result.workflowId ?? '',
                workflowName: result.workflowName ?? '(unknown workflow)',
                versionNumber: result.versionNumber ?? 0,
              }),
              output: result.run.output,
            },
            steps,
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
          // Same tenant-scoping as getRun — never re-dispatch another tenant's run.
          if (!result || result.run.tenantId !== ctx.tenantId) {
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
          const rows = await listAgents(db, ctx.tenantId)
          return json(rows.map((r) => agentSummary(r, r.config)))
        }

        case 'getAgent': {
          const agentId = str(params, 'agentId')
          const result = await getAgent(db, agentId)
          if (!result || result.agent.tenantId !== ctx.tenantId) {
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
            tenantId: ctx.tenantId,
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
          await requireAgentOwned(db, agentId, ctx.tenantId)
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
          await requireAgentOwned(db, agentId, ctx.tenantId)
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
          await requireAgentOwned(db, agentId, ctx.tenantId)
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
          await requireAgentOwned(db, agentId, ctx.tenantId)
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
          await requireAgentOwned(db, agentId, ctx.tenantId)
          await discardAgentDraft(db, { agentId })
          return json({ ok: true })
        }

        case 'countAgentReferences': {
          const agentId = str(params, 'agentId')
          await requireAgentOwned(db, agentId, ctx.tenantId)
          const workflows = await countWorkflowsReferencingAgent(db, {
            tenantId: ctx.tenantId,
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

// Guard a mutation to the caller's tenant before writing.
async function requireOwned(
  db: WfDb,
  workflowId: string,
  tenantId: string,
): Promise<void> {
  const result = await getWorkflow(db, workflowId)
  if (!result || result.workflow.tenantId !== tenantId) {
    throw new Error('Workflow not found')
  }
}

async function requireAgentOwned(
  db: WfDb,
  agentId: string,
  tenantId: string,
): Promise<void> {
  const result = await getAgent(db, agentId)
  if (!result || result.agent.tenantId !== tenantId) {
    throw new Error('Agent not found')
  }
}
