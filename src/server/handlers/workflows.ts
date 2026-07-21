import type { WorkflowGraph } from '../../engine/graph'
import {
  createWorkflow,
  discardDraft,
  getVersionGraph,
  getWorkflow,
  listVersions,
  listWorkflows,
  saveVersion,
  setVersionAiSummary,
  updateDraft,
  updateWorkflow,
} from '../../storage/data'

import type {
  WfChangeSummary,
  WfWorkflowDetail,
  WfWorkflowSummary,
} from '../protocol'
import { summarizeWorkflowChanges } from '../summarize-changes'
import {
  parseGraph,
  requireExists,
  str,
  toEpoch,
  type CreateWfSdkHandlersOptions,
  type WfHandlers,
  type WfServerContext,
} from './shared'

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

export function buildWorkflowHandlers<TDeps>(
  opts: CreateWfSdkHandlersOptions<TDeps>,
): Pick<
  WfHandlers,
  | 'listWorkflows'
  | 'getWorkflow'
  | 'createWorkflow'
  | 'updateDraft'
  | 'saveVersion'
  | 'summarizeChanges'
  | 'updateWorkflow'
  | 'discardDraft'
  | 'listVersions'
  | 'getVersion'
> {
  return {
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
  }
}
